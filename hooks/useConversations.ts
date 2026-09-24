"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "@/lib/inbox-types";
import {
  hotelWhatsappMapFromRecord,
  type HotelWhatsappByIdMap,
} from "@/lib/hotel-whatsapp-map";
import { getConversationDisplayActivityMs } from "@/lib/chat-utils";
import { applyTicketBadges, type InboxTicketBadge } from "@/lib/inbox-ticket-badges";
import { writeStoredActiveHotelId } from "@/lib/active-hotel-storage";
import { type RealtimeUiStatus, useInboxRealtime } from "@/hooks/useInboxRealtime";

type AvailableHotel = {
  id: string;
  name: string;
};

type InboxResponse = {
  conversations: Conversation[];
  /**
   * Hay otra página por keyset. La bandeja llega de a 30 (más el set protegido
   * en la primera) y el resto se pide con `?before=<nextCursor>` al bajar.
   */
  hasMore?: boolean;
  nextCursor?: string | null;
  availableHotels?: AvailableHotel[];
  activeHotelId?: string | null;
  hotelWhatsappById?: Record<string, string>;
  /**
   * `hotels.engine_enabled` del hotel activo. Los hoteles que todavía corren en
   * n8n no tienen el guard de staff, así que la UI de staff se apaga entera
   * para ellos. Ausente = `false`.
   */
  engineEnabled?: boolean;
  /**
   * `hotels.templates_enabled` del hotel activo. En `false` la UI no ofrece
   * enviar plantillas a mano. Ausente = `false`.
   */
  templatesEnabled?: boolean;
  error?: string;
};

function sortByLastActivity(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    return getConversationDisplayActivityMs(b) - getConversationDisplayActivityMs(a);
  });
}

/**
 * Nunca pisar el hilo abierto "hacia abajo": `/api/inbox` trae la conversación
 * sin mensajes. Se conserva lo que hay en memoria cuando ya es autoritativo
 * (`messagesLoaded`) o cuando tiene al menos tantos mensajes como los que
 * llegan; así no se pierden ni el historial cargado ni los parches de Realtime
 * / los envíos optimistas.
 */
function keepOpenThread(incoming: Conversation, prevActive: Conversation | undefined): Conversation {
  if (!prevActive) return incoming;
  const keepLocal =
    prevActive.messagesLoaded || prevActive.messages.length >= incoming.messages.length;
  if (!keepLocal) return incoming;
  return {
    ...incoming,
    messages: prevActive.messages,
    messagesLoaded: prevActive.messagesLoaded,
    olderMessagesCursor: prevActive.olderMessagesCursor,
  };
}

export type RefetchOptions = {
  /**
   * Si es true, no muestra el estado global de carga ni vacía la lista en error
   * (ideal para reconciliación). Además pide SOLO la primera página y la
   * MEZCLA por id sobre lo que ya hay: las páginas que la recepcionista ya bajó
   * no se pierden por un refresco.
   */
  silent?: boolean;
  /** Señal para abortar el fetch en vuelo (p. ej. cuando un cambio de hotel recrea `load`). */
  signal?: AbortSignal;
};

export type UseConversationsOptions = {
  activeConversationId?: string;
  activeHotelId?: string | null;
  /** Ver `UseInboxRealtimeOptions.onQuoteFollowupChanged`. */
  onQuoteFollowupChanged?: () => void;
};

/** Ventana de coalescing para recargas por reconciliación Realtime sin contexto local. */
const MISSING_CONTEXT_DEBOUNCE_MS = 800;

/**
 * Antigüedad mínima del último GET para que volver al tab dispare otro.
 *
 * Sin esto, cada alt-tab costaba una bandeja entera (~569 kB en el hotel más
 * grande) y un asesor entra y sale decenas de veces por turno. Lo que justifica
 * que el refetch exista es el tab dormido LARGO, donde el socket de Realtime
 * pudo morir sin aviso: el canal se suscribe una sola vez en un efecto con deps
 * vacías y no hay reconexión propia, así que nada lo restablece. Esas
 * suspensiones duran minutos, muy por encima de esta ventana.
 */
const VISIBILITY_REFETCH_MIN_AGE_MS = 30_000;

/**
 * Cada cuánto se vuelven a pedir los badges de solicitud.
 *
 * Es polling y es a propósito: `service_tickets` no viaja por Realtime, y quien
 * resuelve una solicitud suele ser el personal operativo desde OTRA tablet. Sin
 * esto, la bandeja de recepción mostraría "Housekeeping · Hab 302" durante todo
 * el turno sobre algo que ya se atendió.
 *
 * No recarga la bandeja: pega contra un endpoint que solo devuelve el mapa de
 * badges (unos pocos kB contra los ~570 kB de `/api/inbox` en el hotel más
 * grande). Y no corre con la pestaña en segundo plano.
 */
const TICKET_BADGES_REFRESH_MS = 60_000;

type TicketBadgesResponse = {
  ticketBadges?: Record<string, InboxTicketBadge>;
  activeHotelId?: string | null;
};

export type { AvailableHotel };

export function useConversations(options?: UseConversationsOptions) {
  const activeHotelId = options?.activeHotelId ?? null;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /**
   * Scroll infinito. `hasMore` = el servidor dijo que hay otra página por
   * keyset; el cursor de la última fila recorrida vive en un ref porque solo lo
   * lee `loadMore` y no debe re-renderizar nada.
   */
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  /**
   * Sube en cada carga NO silenciosa (montaje, cambio de hotel). Una página de
   * `loadMore` que vuelve con otra generación es del hotel anterior y se tira.
   */
  const listGenerationRef = useRef(0);
  /** Hotel de la lista que está en memoria, según la última respuesta aplicada. */
  const resolvedHotelIdRef = useRef<string | null>(null);
  const [availableHotels, setAvailableHotels] = useState<AvailableHotel[]>([]);
  const [resolvedActiveHotelId, setResolvedActiveHotelId] = useState<string | null>(null);
  const [hotelWhatsappById, setHotelWhatsappById] = useState<HotelWhatsappByIdMap>(() => new Map());
  /**
   * Arranca en `false` a propósito: hasta que el servidor confirme que el hotel
   * activo corre en el engine, la bandeja se pinta sin nada de staff. El error
   * barato es que la sección aparezca un instante tarde; el caro sería ofrecer
   * registrar contactos en un hotel donde la IA de n8n les responde igual.
   */
  const [engineEnabled, setEngineEnabled] = useState(false);
  /**
   * Igual que el de arriba, arranca en `false`: hasta que el servidor confirme
   * que el hotel permite plantillas, no se pinta ningún botón para enviarlas.
   * El costo de esperar un instante es que el botón aparece tarde; el de asumir
   * que sí es ofrecer un envío que el servidor rechaza con 403.
   */
  const [templatesEnabled, setTemplatesEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urgentHandoffBannerVisible, setUrgentHandoffBannerVisible] = useState(false);
  const [realtimeUiStatus, setRealtimeUiStatus] = useState<RealtimeUiStatus>("waiting");
  const [realtimeErrorDetail, setRealtimeErrorDetail] = useState<string | undefined>(undefined);
  /**
   * Sube de uno cada vez que el canal vuelve después de haberse caído. Es la
   * señal con la que la bandeja recarga el hilo abierto: durante el corte los
   * mensajes nuevos no llegaron, y Realtime no los reenvía al reconectar.
   */
  const [realtimeRecoveryToken, setRealtimeRecoveryToken] = useState(0);

  const dismissUrgentHandoffBanner = useCallback(() => {
    setUrgentHandoffBannerVisible(false);
  }, []);

  const onRealtimeConnection = useCallback((status: RealtimeUiStatus, detail?: string) => {
    setRealtimeUiStatus(status);
    setRealtimeErrorDetail(status === "error" ? detail : undefined);
  }, []);

  const onRealtimeRecovered = useCallback(() => {
    // La lista se recarga acá; el hilo abierto lo recarga la bandeja leyendo el
    // token, porque este hook no sabe cuál está en pantalla.
    void loadRef.current({ silent: true });
    setRealtimeRecoveryToken((prev) => prev + 1);
  }, []);

  // Ref siempre-actualizado de la conversación activa. Permite que `load` lea el
  // valor vigente SIN listar activeConversationId en sus deps, evitando recrear
  // `load` —y re-disparar el efecto [load], que recarga /api/inbox completo— en
  // cada cambio de conversación seleccionada. Se sincroniza en cada render.
  const activeConversationIdRef = useRef(options?.activeConversationId);
  activeConversationIdRef.current = options?.activeConversationId;

  /**
   * Momento del último GET a `/api/inbox` que terminó bien. Lo escribe `load`,
   * NO el listener de visibilidad, para que lo alimenten todos los
   * disparadores: montaje, reconciliación de Realtime, botón manual y la propia
   * vuelta al tab. Si solo lo tocara `onVisible`, abrir la app y hacer alt-tab
   * en el acto dispararía un GET redundante a los dos segundos del de montaje.
   *
   * Arranca en 0 a propósito: mientras no haya un GET exitoso —incluido el caso
   * en que el de montaje falló— la vuelta al tab siempre reintenta.
   */
  const lastLoadAtRef = useRef(0);

  const load = useCallback(async (refetchOptions?: RefetchOptions) => {
    const silent = refetchOptions?.silent === true;
    const signal = refetchOptions?.signal;
    if (!silent) {
      setLoading(true);
      setError(null);
      // Lista nueva desde cero: cualquier "cargar más" en vuelo queda obsoleto.
      listGenerationRef.current += 1;
    }
    try {
      // Hace un GET a /api/inbox. `useStoredHotelId=false` fuerza la petición sin
      // ?hotelId= (usado por el reintento de auto-recuperación).
      const fetchInbox = async (useStoredHotelId: boolean) => {
        const params = new URLSearchParams();
        if (useStoredHotelId && activeHotelId) {
          params.set("hotelId", activeHotelId);
        }
        const query = params.toString();
        const res = await fetch(query ? `/api/inbox?${query}` : "/api/inbox", {
          cache: "no-store",
          signal,
        });
        const json = (await res.json()) as InboxResponse;
        return { res, json };
      };

      let { res, json } = await fetchInbox(true);

      // Auto-recuperación: si el hotelId almacenado es de un hotel que el usuario
      // actual no tiene permitido, el server responde 403. Descartamos el id stale
      // y reintentamos UNA sola vez sin él → cae a availableHotels[0] (su hotel).
      // El reintento nunca manda hotelId, así que no puede re-disparar este 403.
      if (!res.ok && res.status === 403 && activeHotelId) {
        writeStoredActiveHotelId(null);
        ({ res, json } = await fetchInbox(false));
      }

      if (!res.ok) {
        throw new Error(json.error ?? "No se pudo cargar la bandeja");
      }
      const incoming = json.conversations ?? [];
      const activeId = activeConversationIdRef.current?.trim();
      const incomingCursor = typeof json.nextCursor === "string" ? json.nextCursor : null;
      const incomingHasMore = json.hasMore === true && incomingCursor !== null;
      // Mezclar solo si la respuesta es del MISMO hotel que ya está en
      // pantalla. El reintento por 403 de arriba puede caer en otro hotel, y
      // mezclar ahí dejaría conversaciones de dos hoteles en la misma lista.
      const respondedHotelId = json.activeHotelId ?? null;
      const sameHotel = respondedHotelId === resolvedHotelIdRef.current;
      resolvedHotelIdRef.current = respondedHotelId;
      const replaceAll = !silent || !sameHotel;
      if (silent && !sameHotel) listGenerationRef.current += 1;
      // Silencioso con páginas ya recorridas: la primera página se MEZCLA y el
      // cursor sigue donde estaba. Keyset es estable ante inserciones arriba,
      // así que el cursor viejo sigue apuntando al mismo lugar de la lista.
      const mergeIntoCurrent = !replaceAll && nextCursorRef.current !== null;

      setConversations((prev) => {
        const prevActive = activeId ? prev.find((c) => c.id === activeId) : undefined;
        const fresh = incoming.map((c) =>
          c.id === activeId ? keepOpenThread(c, prevActive) : c
        );
        if (replaceAll) return sortByLastActivity(fresh);

        // Todo lo que ya estaba y no vino en esta primera página se queda:
        // páginas bajadas con el scroll y resultados inyectados por la búsqueda.
        // Realtime los mantiene al día igual que antes.
        const freshIds = new Set(fresh.map((c) => c.id));
        return sortByLastActivity([...fresh, ...prev.filter((c) => !freshIds.has(c.id))]);
      });
      if (!mergeIntoCurrent) {
        nextCursorRef.current = incomingHasMore ? incomingCursor : null;
        setHasMore(incomingHasMore);
      }
      setAvailableHotels(json.availableHotels ?? []);
      setResolvedActiveHotelId(json.activeHotelId ?? null);
      setHotelWhatsappById(hotelWhatsappMapFromRecord(json.hotelWhatsappById ?? {}));
      // Se aplica en el MISMO lote que `conversations` y `activeHotelId`: al
      // cambiar de hotel, lista y flag cambian juntos y no hay un frame con las
      // conversaciones nuevas y el flag del hotel anterior.
      setEngineEnabled(json.engineEnabled === true);
      setTemplatesEnabled(json.templatesEnabled === true);
      setError(null);
      // Único punto donde se sella: acá el GET ya respondió y se aplicó. Un
      // fetch abortado o fallido cae al catch y no cuenta como reciente.
      lastLoadAtRef.current = Date.now();
    } catch (e) {
      // Fetch abortado (p. ej. un cambio de hotel recreó `load` y canceló este):
      // no es un error de UI, simplemente quedó obsoleto.
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (!silent) {
        setError(e instanceof Error ? e.message : "Error de red");
        setConversations([]);
        nextCursorRef.current = null;
        setHasMore(false);
      } else {
        console.warn("[useConversations] Refresco silencioso falló", e);
      }
    } finally {
      // Si se abortó, un nuevo `load` ya tomó el control del estado de carga:
      // no lo apaguemos por debajo del fetch vigente.
      if (!silent && !signal?.aborted) setLoading(false);
    }
  }, [activeHotelId]);

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  const loadRef = useRef(load);
  loadRef.current = load;

  /**
   * Siguiente página por keyset, anexada por id al final de lo que hay. La
   * dispara el scroll de la lista al llegar abajo.
   *
   * Lo que ya está en memoria GANA sobre lo que trae la página: puede tener
   * mensajes cargados o parches de Realtime más nuevos que la foto del GET.
   * Solo entran las filas que faltaban (p. ej. una protegida que ya había
   * llegado en la primera carga no se duplica ni se pisa).
   *
   * Nunca vacía la lista ni muestra error de pantalla: si falla, `hasMore`
   * queda como estaba y el próximo scroll reintenta.
   */
  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    const generation = listGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ before: cursor });
      if (activeHotelId) params.set("hotelId", activeHotelId);
      const res = await fetch(`/api/inbox?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as InboxResponse;
      if (!res.ok) throw new Error(json.error ?? "No se pudo cargar más conversaciones");
      // Cambió el hotel (o se recargó la lista desde cero) mientras volvía.
      if (generation !== listGenerationRef.current) return;
      // Otro `loadMore` ya avanzó el cursor: esta página es vieja.
      if (nextCursorRef.current !== cursor) return;

      const page = json.conversations ?? [];
      setConversations((prev) => {
        const known = new Set(prev.map((c) => c.id));
        const added = page.filter((c) => !known.has(c.id));
        if (added.length === 0) return prev;
        return sortByLastActivity([...prev, ...added]);
      });
      const cursorOut = typeof json.nextCursor === "string" ? json.nextCursor : null;
      const more = json.hasMore === true && cursorOut !== null;
      nextCursorRef.current = more ? cursorOut : null;
      setHasMore(more);
    } catch (e) {
      console.warn("[useConversations] No se pudo cargar la página siguiente", e);
    } finally {
      loadingMoreRef.current = false;
      if (generation === listGenerationRef.current) setLoadingMore(false);
    }
  }, [activeHotelId]);

  // Cambio de hotel: la carga no silenciosa ya subió la generación; acá se
  // apaga el spinner de una página del hotel anterior que quedó en vuelo.
  useEffect(() => {
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [activeHotelId]);

  // Debounce trailing-edge SOLO para el camino de reconciliación Realtime
  // (`onMissingContext`): si llegan varios eventos sin contexto en una ventana
  // corta, se colapsan en UNA sola recarga al final de la ráfaga, en vez de una
  // recarga completa por evento. No afecta montaje ni visibilitychange.
  const missingContextTimerRef = useRef<number | null>(null);

  const scheduleMissingContextReload = useCallback(() => {
    if (missingContextTimerRef.current != null) {
      window.clearTimeout(missingContextTimerRef.current);
    }
    missingContextTimerRef.current = window.setTimeout(() => {
      missingContextTimerRef.current = null;
      void loadRef.current({ silent: true });
    }, MISSING_CONTEXT_DEBOUNCE_MS);
  }, []);

  // Limpia el timer pendiente al desmontar: evita recargas tras unmount y fugas.
  useEffect(() => {
    return () => {
      if (missingContextTimerRef.current != null) {
        window.clearTimeout(missingContextTimerRef.current);
        missingContextTimerRef.current = null;
      }
    };
  }, []);

  const markConversationRead = useCallback(async (conversationId: string) => {
    const id = conversationId.trim();
    if (!id) return;

    setConversations((prev) =>
      prev.map((c) => (c.id === id && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c))
    );

    try {
      const res = await fetch("/api/inbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id, action: "mark_read" }),
      });
      if (!res.ok) {
        throw new Error(`mark_read ${res.status}`);
      }
    } catch (e) {
      console.warn("[useConversations] No se pudo marcar como leída", e);
      void loadRef.current({ silent: true });
    }
  }, []);

  // Reconciliación puntual: refetch silencioso cuando la pestaña vuelve al foco,
  // útil si el socket de Realtime estuvo en background o el tab estuvo dormido.
  // Con throttle por antigüedad: ver `VISIBILITY_REFETCH_MIN_AGE_MS`.
  useEffect(() => {
    const onVisible = () => {
      if (typeof document === "undefined" || document.hidden) return;
      if (Date.now() - lastLoadAtRef.current < VISIBILITY_REFETCH_MIN_AGE_MS) return;
      void loadRef.current({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /**
   * Refresco de los badges de solicitud. Ver `TICKET_BADGES_REFRESH_MS`.
   *
   * Best-effort de punta a punta: cualquier fallo se ignora en silencio y la
   * bandeja se queda con los badges que ya tiene. Este refresco NUNCA puede
   * vaciar la lista ni mostrar un error — lo único que hay en juego es que un
   * distintivo informativo tarde un minuto más en apagarse.
   */
  useEffect(() => {
    const hotelId = resolvedActiveHotelId;
    if (!hotelId) return;

    const controller = new AbortController();

    const refresh = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(
          `/api/inbox/ticket-badges?hotelId=${encodeURIComponent(hotelId)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) return;
        const json = (await res.json()) as TicketBadgesResponse;
        // Respuesta de otro hotel (cambio de hotel mientras estaba en vuelo):
        // se descarta en vez de pegar badges ajenos sobre la bandeja actual.
        if ((json.activeHotelId ?? null) !== hotelId) return;
        const badges = json.ticketBadges ?? {};
        setConversations((prev) => applyTicketBadges(prev, badges));
      } catch {
        /* refresco informativo: si falla, se reintenta al minuto siguiente */
      }
    };

    const timer = window.setInterval(() => {
      void refresh();
    }, TICKET_BADGES_REFRESH_MS);

    // Al volver de segundo plano se pide de una, sin esperar el minuto: es
    // justo cuando más desactualizado está el badge.
    const onVisible = () => {
      if (typeof document === "undefined" || document.hidden) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resolvedActiveHotelId]);

  useEffect(() => {
    if (!urgentHandoffBannerVisible) return;
    const t = window.setTimeout(() => {
      setUrgentHandoffBannerVisible(false);
    }, 8000);
    return () => clearTimeout(t);
  }, [urgentHandoffBannerVisible]);

  // Realtime: reemplaza el polling. Si llega un evento sin contexto local
  // (p. ej. nueva conversación o mensaje de un teléfono aún no cargado),
  // disparamos un refetch silencioso para reconciliar.
  useInboxRealtime({
    setConversations,
    activeConversationId: options?.activeConversationId,
    activeHotelId: resolvedActiveHotelId,
    hotelWhatsappById,
    onMissingContext: () => {
      scheduleMissingContextReload();
    },
    onUrgentHandoffBanner: () => {
      setUrgentHandoffBannerVisible(true);
    },
    onRealtimeConnection,
    onRealtimeRecovered,
    onQuoteFollowupChanged: options?.onQuoteFollowupChanged,
  });

  return {
    conversations,
    setConversations,
    hasMore,
    loadingMore,
    loadMore,
    loading,
    error,
    refetch: load,
    markConversationRead,
    urgentHandoffBannerVisible,
    dismissUrgentHandoffBanner,
    realtimeUiStatus,
    realtimeErrorDetail,
    realtimeRecoveryToken,
    availableHotels,
    activeHotelId: resolvedActiveHotelId,
    engineEnabled,
    templatesEnabled,
  };
}
