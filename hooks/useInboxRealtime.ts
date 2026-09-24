"use client";

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATIONS_TABLE,
  type ConversationDbRow,
} from "@/lib/conversation-schema";
import { upsertConversationMessage } from "@/lib/message-upsert";
import { WUBBY_TABLE, type WubbyWhatsappRow } from "@/lib/wubby-schema";
import {
  type HotelWhatsappByIdMap,
  readRowHotelId,
  resolveHotelWaIdentitiesForRow,
} from "@/lib/hotel-whatsapp-map";
import type { Conversation } from "@/lib/inbox-types";
import {
  applyConversationRowPatch,
  buildMessageFromWubbyRow,
  findConversationForWubbyRow,
  getConversationDisplayActivityMs,
  getMessageDisplayMs,
  messageNeedsHumanAlert,
  normalizeWaIdentity,
} from "@/lib/chat-utils";

type SetConversations = Dispatch<SetStateAction<Conversation[]>>;

type ConversationsPayload = RealtimePostgresChangesPayload<ConversationDbRow>;
type WubbyPayload = RealtimePostgresChangesPayload<WubbyWhatsappRow>;

/**
 * Estado visible del chip de conexión Realtime en la barra superior.
 *
 * `reconnecting` no es cosmético: cuando el canal se cae, la librería reintenta
 * el join sola con backoff y en la mayoría de los casos vuelve en segundos. Ese
 * rato NO es "actualiza a mano" —no hay nada que la recepcionista tenga que
 * hacer—, pero tampoco es "en línea": mientras dura, los mensajes que lleguen
 * se pierden, porque Realtime no reenvía lo que pasó mientras estabas afuera.
 * Por eso al volver se recarga el hilo abierto.
 */
export type RealtimeUiStatus = "waiting" | "connected" | "reconnecting" | "error";

/**
 * Cuánto se le da al reintento automático antes de dejar de decir
 * "Reconectando…" y admitir que hay que refrescar. Sin este techo, un canal que
 * rebota para siempre (por ejemplo por un problema de permisos) se vería igual
 * que un bache de wifi de tres segundos, y la recepcionista se quedaría
 * esperando una bandeja que no va a volver sola.
 */
const RECONNECTING_GRACE_MS = 20_000;

export type UseInboxRealtimeOptions = {
  setConversations: SetConversations;
  activeConversationId?: string;
  /** Hotel cargado en bandeja; enruta mensajes Wubby solo a conversaciones de ese tenant. */
  activeHotelId?: string | null;
  hotelWhatsappById: HotelWhatsappByIdMap;
  /**
   * Se llama cuando llega un evento para el que no tenemos contexto local
   * (p. ej. INSERT en `conversations`, o mensaje de un teléfono desconocido).
   * Típicamente dispara un refetch silencioso para reconciliar.
   */
  onMissingContext?: () => void;
  /** Banner in-app único cuando hay alerta urgente (aunque falle Notification API). */
  onUrgentHandoffBanner?: () => void;
  /** Chip: esperando / conectado / reconectando / error. */
  onRealtimeConnection?: (status: RealtimeUiStatus, detail?: string) => void;
  /**
   * El canal volvió después de haberse caído. Lo que pasó durante el corte NO
   * llega solo —Realtime no tiene replay—, así que el consumidor tiene que
   * recargar lo que esté mostrando.
   */
  onRealtimeRecovered?: () => void;
  /**
   * Cambió el estado de cotización o de seguimiento de una conversación
   * (`quote_followup_due_at`, `quote_followup_sent`, `quote_followup_sent_at` o
   * `cotizacion`). El consumidor recarga los timers de seguimiento; reemplaza el
   * poll de 60 s de `get_pending_followups`.
   */
  onQuoteFollowupChanged?: () => void;
};

/** Columnas de `conversations` que mueven los timers de seguimiento. */
const FOLLOWUP_COLUMNS = [
  "quote_followup_due_at",
  "quote_followup_sent",
  "quote_followup_sent_at",
  "cotizacion",
] as const;

/**
 * Huella de las columnas de seguimiento de una fila. `null` = la fila no trae
 * ninguna de esas columnas con valor (sin cotización ni seguimiento).
 *
 * Se compara contra la última huella vista de la misma conversación en vez de
 * contra `payload.old`: sin `REPLICA IDENTITY FULL`, `payload.old` de un UPDATE
 * trae solo la PK y no dice qué cambió.
 */
function followupSignature(row: Record<string, unknown>): string | null {
  const values = FOLLOWUP_COLUMNS.map((column) => row[column] ?? null);
  if (values.every((value) => value === null || value === false || value === "")) return null;
  return JSON.stringify(values);
}

/** Reordena la lista por `lastActivityIso` descendente. */
function sortByActivity(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const ta = getConversationDisplayActivityMs(a);
    const tb = getConversationDisplayActivityMs(b);
    return tb - ta;
  });
}

function truncatePreview(preview: string): string {
  return preview.length > 120 ? `${preview.slice(0, 117)}…` : preview;
}

/** guest_phone (normalizado) + hotel_id del row Wubby vs hotel activo en memoria. */
function rowMatchesInboxHotel(
  row: WubbyWhatsappRow,
  activeHotelId: string | null | undefined
): boolean {
  const rowHotelId = readRowHotelId(row);
  if (!rowHotelId) return true;
  const active = activeHotelId?.trim();
  if (!active) return true;
  return rowHotelId === active;
}

function findConversationForRealtimeRow(
  conversations: Conversation[],
  row: WubbyWhatsappRow,
  activeHotelId: string | null | undefined
): Conversation | null {
  if (!rowMatchesInboxHotel(row, activeHotelId)) return null;
  return findConversationForWubbyRow(conversations, row);
}

const URGENT_NOTIFICATION_TITLE = "🚨 Huésped requiere atención humana";
/** Por defecto 2 min. Para pruebas, cambiar temporalmente (ej. `10 * 1000`). */
const URGENT_ALERT_COOLDOWN_MS = 2 * 60 * 1000;

/** Clave estable por caso (teléfono / conversación), no por id de mensaje. */
function readUrgentConversationKey(row: WubbyWhatsappRow): string {
  const r = row as Record<string, unknown>;
  const candidates: unknown[] = [
    r.conversation_id,
    r.Conversation_ID,
    r.conversationId,
    r.from,
    r.sender,
    r.phone,
    r.guest_phone,
    r.Guest_Phone,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const str = String(c).trim();
    if (!str) continue;
    const norm = normalizeWaIdentity(str);
    if (norm) return norm;
    return str;
  }
  return String(row.id);
}

function buildUrgentHandoffBody(displayNameOrPhone: string, messagePreview: string): string {
  const who = displayNameOrPhone.trim();
  const prev = (messagePreview ?? "").trim();
  if (!who && !prev) {
    return "Un huésped solicitó atención humana.";
  }
  if (!who) {
    return prev.length > 220 ? `${prev.slice(0, 217)}…` : prev;
  }
  if (!prev) {
    return who.length > 220 ? `${who.slice(0, 217)}…` : who;
  }
  const line = `${who}: ${prev}`;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function playUrgentHandoffBeep(): void {
  try {
    type WinAudio = typeof window & { webkitAudioContext?: typeof AudioContext };
    const AC = window.AudioContext ?? (window as WinAudio).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    void ctx.resume?.().catch(() => {});
  } catch {
    /* sin audio */
  }
}

/**
 * Supabase Realtime para la bandeja.
 * Reemplaza al polling: se suscribe a `public.conversations` y `public.Wubby_Whatsapp`
 * y aplica parches incrementales al estado de conversaciones.
 */
export function useInboxRealtime({
  setConversations,
  activeConversationId,
  activeHotelId,
  hotelWhatsappById,
  onMissingContext,
  onUrgentHandoffBanner,
  onRealtimeConnection,
  onRealtimeRecovered,
  onQuoteFollowupChanged,
}: UseInboxRealtimeOptions) {
  const setConversationsRef = useRef(setConversations);
  const activeConversationIdRef = useRef(activeConversationId);
  const activeHotelIdRef = useRef(activeHotelId);
  const hotelWhatsappByIdRef = useRef(hotelWhatsappById);
  const onMissingRef = useRef(onMissingContext);
  const onUrgentBannerRef = useRef(onUrgentHandoffBanner);
  const onConnRef = useRef(onRealtimeConnection);
  const onRecoveredRef = useRef(onRealtimeRecovered);
  const onQuoteFollowupChangedRef = useRef(onQuoteFollowupChanged);
  /**
   * Última huella de seguimiento vista por conversación (ver
   * `followupSignature`). Vive fuera del efecto del canal para que sobreviva a
   * una re-suscripción.
   */
  const followupSignatureByIdRef = useRef<Map<string, string | null>>(new Map());
  /**
   * Algún canal de este hook ya llegó a SUBSCRIBED. Sobrevive a la
   * re-suscripción por cambio de hotel: el primer SUBSCRIBED del canal nuevo
   * dispara una recarga, porque entre el cierre del canal viejo y el alta del
   * nuevo pudo entrar algo que ninguno de los dos vio.
   */
  const everSubscribedRef = useRef(false);

  /** Último aviso urgente por clave de conversación / caso. */
  const urgentNotifiedAtRef = useRef<Map<string, number>>(new Map());
  /** Una notificación de escritorio activa por `urgentKey` (cierra la anterior al reemplazar). */
  const activeDesktopNotificationsRef = useRef<Map<string, Notification>>(new Map());

  useEffect(() => {
    setConversationsRef.current = setConversations;
  }, [setConversations]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activeHotelIdRef.current = activeHotelId;
  }, [activeHotelId]);

  useEffect(() => {
    hotelWhatsappByIdRef.current = hotelWhatsappById;
  }, [hotelWhatsappById]);

  useEffect(() => {
    onMissingRef.current = onMissingContext;
  }, [onMissingContext]);

  useEffect(() => {
    onUrgentBannerRef.current = onUrgentHandoffBanner;
  }, [onUrgentHandoffBanner]);

  useEffect(() => {
    onConnRef.current = onRealtimeConnection;
  }, [onRealtimeConnection]);

  useEffect(() => {
    onRecoveredRef.current = onRealtimeRecovered;
  }, [onRealtimeRecovered]);

  useEffect(() => {
    onQuoteFollowupChangedRef.current = onQuoteFollowupChanged;
  }, [onQuoteFollowupChanged]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }, []);

  /**
   * Hotel del canal. Con él se filtran las suscripciones en el servidor: antes
   * iban sin filtro y Realtime evaluaba cada cambio de CUALQUIER hotel contra
   * la RLS de cada suscriptor, para que el cliente lo descartara después.
   */
  const channelHotelId = activeHotelId?.trim() || null;

  useEffect(() => {
    // Sin hotel resuelto todavía (la bandeja no respondió) no hay qué filtrar:
    // el chip queda en "esperando" y el efecto vuelve a correr cuando llegue.
    if (!channelHotelId) {
      onConnRef.current?.("waiting");
      return;
    }
    const hotelFilter = `hotel_id=eq.${channelHotelId}`;

    if (process.env.NODE_ENV === "development") {
      for (const n of activeDesktopNotificationsRef.current.values()) {
        try {
          n.close();
        } catch {
          /* ignore */
        }
      }
      activeDesktopNotificationsRef.current.clear();
      urgentNotifiedAtRef.current.clear();
      console.log("[Urgent Alert] dev: cooldown + desktop notification map cleared on realtime mount");
    }

    let supabase: ReturnType<typeof createClient> | null = null;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    /**
     * Ya estuvimos conectados alguna vez en esta sesión. Distingue "primer
     * enganche" de "volvió después de caerse", que es lo único que obliga a
     * recargar el hilo.
     */
    let wasConnected = false;
    /** Cuenta atrás de `RECONNECTING_GRACE_MS`; `null` = no hay caída en curso. */
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const activeDesktopNotifications = activeDesktopNotificationsRef.current;

    try {
      supabase = createClient();
    } catch (e) {
      console.warn("[inbox realtime] cliente no inicializado", e);
      onConnRef.current?.(
        "error",
        e instanceof Error ? e.message : "cliente Supabase no inicializado"
      );
      return;
    }

    const requestMissing = () => onMissingRef.current?.();

    function handleUrgentHandoffRealtimeRow(
      row: WubbyWhatsappRow,
      displayNameOrPhone: string,
      preview: string
    ): void {
      const rowRec = row as Record<string, unknown>;
      const needs = messageNeedsHumanAlert(rowRec);

      if (!needs) {
        return;
      }

      const urgentKey = readUrgentConversationKey(row);

      const now = Date.now();
      const last = urgentNotifiedAtRef.current.get(urgentKey) ?? 0;

      if (now - last < URGENT_ALERT_COOLDOWN_MS) {
        return;
      }
      urgentNotifiedAtRef.current.set(urgentKey, now);

      queueMicrotask(() => {
        onUrgentBannerRef.current?.();
        playUrgentHandoffBeep();
        const body = buildUrgentHandoffBody(displayNameOrPhone, preview);
        // Sin API o sin permiso no es un fallo que reportar: el banner in-app y
        // el beep de arriba ya avisaron, y el permiso es elección del usuario.
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            const previousNotification = activeDesktopNotificationsRef.current.get(urgentKey);
            if (previousNotification) {
              previousNotification.close();
              activeDesktopNotificationsRef.current.delete(urgentKey);
            }

            const notification = new Notification(URGENT_NOTIFICATION_TITLE, {
              body,
              requireInteraction: true,
            });

            activeDesktopNotificationsRef.current.set(urgentKey, notification);

            notification.onclick = () => {
              window.focus();
              notification.close();
              activeDesktopNotificationsRef.current.delete(urgentKey);
            };

            notification.onclose = () => {
              activeDesktopNotificationsRef.current.delete(urgentKey);
            };
          } catch (e) {
            console.warn("[Urgent Alert] notification failed (exception)", e);
          }
        }
      });
    }

    const handleConversationEvent = (payload: ConversationsPayload) => {
      const eventType = payload.eventType;
      const setter = setConversationsRef.current;

      if (eventType === "DELETE") {
        const oldRow = payload.old as Partial<ConversationDbRow> | null;
        const oldId = oldRow?.id;
        if (!oldId) return;
        setter((prev) => prev.filter((c) => c.id !== oldId));
        return;
      }

      const newRow = payload.new as ConversationDbRow | null;
      if (!newRow || !newRow.id) return;

      // Timers de seguimiento: aviso solo si la huella cambió respecto de la
      // última vista. La primera vez que se ve una conversación no hay contra
      // qué comparar, así que se avisa solo si trae cotización o seguimiento.
      const signature = followupSignature(newRow as unknown as Record<string, unknown>);
      const signatures = followupSignatureByIdRef.current;
      const known = signatures.has(newRow.id);
      const previous = signatures.get(newRow.id);
      signatures.set(newRow.id, signature);
      if (known ? previous !== signature : signature !== null) {
        onQuoteFollowupChangedRef.current?.();
      }

      if (eventType === "INSERT") {
        setter((prev) => {
          if (prev.some((c) => c.id === newRow.id)) return prev;
          requestMissing();
          return prev;
        });
        return;
      }

      setter((prev) => {
        const idx = prev.findIndex((c) => c.id === newRow.id);
        if (idx === -1) {
          requestMissing();
          return prev;
        }
        const next = [...prev];
        next[idx] = applyConversationRowPatch(next[idx]!, newRow);
        return next;
      });
    };

    type HandoffQueue = {
      row: WubbyWhatsappRow;
      displayNameOrPhone: string;
      preview: string;
    } | null;

    const handleWubbyInsert = (payload: WubbyPayload) => {
      const row = payload.new as WubbyWhatsappRow | null;
      if (!row) return;
      const setter = setConversationsRef.current;

      const handoffSlot: { current: HandoffQueue } = { current: null };

      setter((prev) => {
        const target = findConversationForRealtimeRow(prev, row, activeHotelIdRef.current);
        if (!target) {
          if (rowMatchesInboxHotel(row, activeHotelIdRef.current)) {
            requestMissing();
          }
          return prev;
        }
        const built = buildMessageFromWubbyRow(
          row,
          target.guestPhone,
          resolveHotelWaIdentitiesForRow(row, hotelWhatsappByIdRef.current)
        );
        const rowNeedsUrgent = messageNeedsHumanAlert(row as Record<string, unknown>);

        const urgentVisualPatch =
          rowNeedsUrgent && target.operationalStatus !== "closed"
            ? ({
                request: "pending" as const,
                needsHuman: true,
                aiActive: false,
                operationalStatus: "requires_attention" as const,
                controlMode: "human" as const,
              } satisfies Partial<Conversation>)
            : {};

        if (rowNeedsUrgent) {
          const name = (target.guest.name ?? "").trim();
          const phone = (target.guestPhone ?? target.guest.phone ?? "").trim();
          handoffSlot.current = {
            row,
            displayNameOrPhone: name || phone,
            preview: built.previewRaw,
          };
        }

        const updated = prev.map((c) => {
          if (c.id !== target.id) return c;
          const shouldBumpPreview =
            getMessageDisplayMs(built.message as unknown as Record<string, unknown>) >=
            getConversationDisplayActivityMs(c);
          const isActiveConversation = c.id === activeConversationIdRef.current;
          const nextUnreadCount =
            built.message.sender === "user"
              ? isActiveConversation || c.operationalStatus === "closed"
                ? 0
                : c.unreadCount + 1
              : 0;
          return {
            ...c,
            ...urgentVisualPatch,
            messages: upsertConversationMessage(c.messages, built.message),
            lastMessagePreview: shouldBumpPreview
              ? truncatePreview(built.previewRaw)
              : c.lastMessagePreview,
            lastMessageAt: shouldBumpPreview ? built.lastMessageLabel : c.lastMessageAt,
            lastActivityIso: shouldBumpPreview ? built.createdAtIso : c.lastActivityIso,
            unreadCount: nextUnreadCount,
          };
        });
        return sortByActivity(updated);
      });

      const hp = handoffSlot.current;
      if (messageNeedsHumanAlert(row as Record<string, unknown>)) {
        if (hp) {
          handleUrgentHandoffRealtimeRow(hp.row, hp.displayNameOrPhone, hp.preview);
        } else {
          console.log(
            "[Urgent Alert] INSERT: needsHuman true but no handoff context (conversation not in memory / duplicate id); silent refetch may be needed"
          );
        }
      }
    };

    const handleWubbyUpdate = (payload: WubbyPayload) => {
      const newRow = payload.new as WubbyWhatsappRow | null;
      if (!newRow) return;
      const oldRow = (payload.old ?? {}) as Record<string, unknown>;
      const messageId = String(newRow.id);
      const setter = setConversationsRef.current;

      const wasUrgent = messageNeedsHumanAlert(oldRow);
      const isUrgent = messageNeedsHumanAlert(newRow as Record<string, unknown>);

      const handoffSlot: { current: HandoffQueue } = { current: null };

      setter((prev) => {
        // Empareja por teléfono, igual que el camino INSERT, en vez de buscar el
        // mensaje dentro de `c.messages`: la bandeja ya no trae historial, así
        // que ese array está vacío y el UPDATE dejaría de aplicar el parche
        // visual de urgencia (fila roja) en toda conversación sin hilo abierto.
        const target = findConversationForRealtimeRow(prev, newRow, activeHotelIdRef.current);
        if (!target) return prev;

        const built = buildMessageFromWubbyRow(
          newRow,
          target.guestPhone,
          resolveHotelWaIdentitiesForRow(newRow, hotelWhatsappByIdRef.current)
        );

        if (isUrgent) {
          const name = (target.guest.name ?? "").trim();
          const phone = (target.guestPhone ?? target.guest.phone ?? "").trim();
          handoffSlot.current = {
            row: newRow,
            displayNameOrPhone: name || phone,
            preview: built.previewRaw,
          };
        }

        return prev.map((c) => {
          if (c.id !== target.id) return c;

          const urgentVisualPatch =
            isUrgent && c.operationalStatus !== "closed"
              ? ({
                  request: "pending" as const,
                  needsHuman: true,
                  aiActive: false,
                  operationalStatus: "requires_attention" as const,
                  controlMode: "human" as const,
                } satisfies Partial<Conversation>)
              : {};

          // El hilo local solo se parchea si el mensaje está cargado. Si no está
          // (bandeja sin historial, o mensaje fuera del tramo abierto) se deja
          // intacto: no hay nada que actualizar en pantalla.
          const mi = c.messages.findIndex((m) => m.id === messageId);
          let messages = c.messages;
          if (mi !== -1) {
            messages = [...c.messages];
            messages[mi] = built.message;
          }

          // Antes el bump se decidía con `mi === c.messages.length - 1`, que sin
          // array es indecidible. Se compara el timestamp del mensaje contra la
          // actividad ya mostrada, el mismo criterio que usa handleWubbyInsert.
          const shouldBumpPreview =
            getMessageDisplayMs(built.message as unknown as Record<string, unknown>) >=
            getConversationDisplayActivityMs(c);

          return {
            ...c,
            ...urgentVisualPatch,
            messages,
            lastMessagePreview: shouldBumpPreview
              ? truncatePreview(built.previewRaw)
              : c.lastMessagePreview,
            lastMessageAt: shouldBumpPreview ? built.lastMessageLabel : c.lastMessageAt,
            lastActivityIso: shouldBumpPreview ? built.createdAtIso : c.lastActivityIso,
          };
        });
      });

      const hp = handoffSlot.current;
      if (isUrgent && hp) {
        if (process.env.NODE_ENV === "development" && wasUrgent) {
          console.log(
            "[Urgent Alert] UPDATE debug: calling handler while wasUrgent is true (cooldown dedupes)"
          );
        }
        handleUrgentHandoffRealtimeRow(hp.row, hp.displayNameOrPhone, hp.preview);
      } else if (isUrgent && !hp) {
        console.log(
          "[Urgent Alert] UPDATE: needsHuman true but no conversation matched the row phone (other hotel or not loaded)"
        );
      }
    };

    const handleWubbyDelete = (payload: WubbyPayload) => {
      const oldRow = payload.old as Partial<WubbyWhatsappRow> | null;
      if (!oldRow || oldRow.id == null) return;
      const messageId = String(oldRow.id);
      const setter = setConversationsRef.current;
      setter((prev) =>
        prev.map((c) => {
          // Mismo criterio que en UPDATE: la ausencia en el array local no
          // dispara `onMissingContext`. Solo es concluyente si
          // `c.messagesLoaded === true`, y aun así no justifica recargar.
          if (!c.messages.some((m) => m.id === messageId)) return c;
          return {
            ...c,
            messages: c.messages.filter((m) => m.id !== messageId),
          };
        })
      );
    };

    const handleWubbyPostgresChange = (payload: WubbyPayload) => {
      const et = payload.eventType;
      if (et === "INSERT") {
        handleWubbyInsert(payload);
      } else if (et === "UPDATE") {
        handleWubbyUpdate(payload);
      } else if (et === "DELETE") {
        handleWubbyDelete(payload);
      }
    };

    onConnRef.current?.("waiting");

    // El join adjunta el access_token solo si `realtime.setAuth()` ya corrió, y
    // `createBrowserClient` resuelve la sesión de forma asíncrona: suscribir de
    // inmediato puede unir el canal con claims de `anon`. Hoy es invisible
    // (policy RLS abierta); con RLS cerrada ese canal no recibiría nada.
    const client = supabase;
    void (async () => {
      let accessToken: string | undefined;
      try {
        const {
          data: { session },
        } = await client.auth.getSession();
        accessToken = session?.access_token;
        if (accessToken) {
          await client.realtime.setAuth(accessToken);
        }
      } catch (e) {
        console.warn("[inbox realtime] no se pudo resolver la sesión", e);
        if (!cancelled) {
          onConnRef.current?.(
            "error",
            e instanceof Error ? e.message : "sesión no disponible"
          );
        }
        return;
      }

      // Sin `await` entre esta guarda y la asignación de `channel`: el cleanup
      // no puede colarse en el medio y dejar un canal huérfano.
      if (cancelled) return;

      if (!accessToken) {
        onConnRef.current?.("error", "sesión no disponible");
        return;
      }

      const onConversation = handleConversationEvent as (
        payload: RealtimePostgresChangesPayload<Record<string, unknown>>
      ) => void;
      const onWubby = handleWubbyPostgresChange as (
        payload: RealtimePostgresChangesPayload<Record<string, unknown>>
      ) => void;

      // INSERT y UPDATE van filtrados por hotel en el servidor. DELETE va SIN
      // filtro a propósito: sin `REPLICA IDENTITY FULL` la fila borrada llega
      // solo con la PK, el servidor no puede evaluar `hotel_id` y el evento se
      // perdería. Los handlers de DELETE solo quitan por id lo que ya está en
      // pantalla, así que un borrado de otro hotel no cambia nada visible.
      //
      // Nombre por hotel: `client.channel()` devuelve el canal existente si el
      // nombre coincide, y el `removeChannel` del canal anterior es async.
      channel = client
        .channel(`inbox-realtime:${channelHotelId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: CONVERSATIONS_TABLE, filter: hotelFilter },
          onConversation
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: CONVERSATIONS_TABLE, filter: hotelFilter },
          onConversation
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: CONVERSATIONS_TABLE },
          onConversation
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: WUBBY_TABLE, filter: hotelFilter },
          onWubby
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: WUBBY_TABLE, filter: hotelFilter },
          onWubby
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: WUBBY_TABLE },
          onWubby
        )
        .subscribe((status, err) => {
          // Al desmontar, el `removeChannel` del cleanup dispara `CLOSED`. Sin
          // esta guarda ese cierre normal pintaba el chip en rojo justo cuando
          // la bandeja ya no está en pantalla.
          if (cancelled) return;

          if (status === "SUBSCRIBED") {
            if (graceTimer !== null) {
              clearTimeout(graceTimer);
              graceTimer = null;
            }
            onConnRef.current?.("connected");
            // Solo es "recuperación" si antes ya habíamos estado conectados y
            // nos caímos. El primer SUBSCRIBED de la sesión no recarga nada:
            // la bandeja acaba de cargar el hilo por su cuenta.
            //
            // Excepción: el primer SUBSCRIBED de un canal nuevo por cambio de
            // hotel sí recarga, para cubrir el hueco entre canal viejo y nuevo.
            if (wasConnected || everSubscribedRef.current) {
              onRecoveredRef.current?.();
            }
            wasConnected = true;
            everSubscribedRef.current = true;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            // La librería reintenta el join sola con backoff. Mientras dure eso
            // el estado honesto es "reconectando", no "actualiza a mano".
            onConnRef.current?.("reconnecting", err?.message ?? String(status));
            if (err) {
              console.warn("[inbox realtime] error de suscripción", status, err);
            }
            // Un solo temporizador por caída: si a los 20 s no volvió, el
            // reintento automático no está funcionando y hay que decirlo.
            if (graceTimer === null) {
              graceTimer = setTimeout(() => {
                graceTimer = null;
                if (cancelled) return;
                onConnRef.current?.("error", "la conexión no se restableció sola");
              }, RECONNECTING_GRACE_MS);
            }
          } else if (status === "CLOSED") {
            onConnRef.current?.("error", String(status));
          }
        });
    })();

    return () => {
      cancelled = true;

      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }

      for (const n of activeDesktopNotifications.values()) {
        try {
          n.close();
        } catch {
          /* ignore */
        }
      }
      activeDesktopNotifications.clear();

      if (channel && supabase) {
        try {
          void supabase.removeChannel(channel);
        } catch (e) {
          console.warn("[inbox realtime] error al limpiar canal", e);
        }
      }
    };
  }, [channelHotelId]);
}
