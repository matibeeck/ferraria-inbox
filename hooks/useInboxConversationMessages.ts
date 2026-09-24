"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getMessageDisplayMs } from "@/lib/chat-utils";
import type { Conversation, Message, MessageDeliveryReceipt } from "@/lib/inbox-types";

type MessagesResponse = {
  messages?: Message[];
  hasOlder?: boolean;
  olderCursor?: string | null;
  /** Acuses de Meta de los mensajes de ESTA página. */
  statuses?: MessageDeliveryReceipt[];
  error?: string;
};

function messageMs(m: Message): number {
  return getMessageDisplayMs(m as unknown as Record<string, unknown>);
}

/** Burbuja que existe solo en este navegador: todavía no hay fila en la base. */
function isLocalOnly(m: Message): boolean {
  return m.status === "pending" || m.status === "failed";
}

/**
 * Aplica la página MÁS NUEVA del hilo (la de abrir o recargar) sobre lo que ya
 * hay en memoria.
 *
 * - Las burbujas "Enviando…" / "No se envió" se conservan mientras el servidor
 *   no las traiga ya guardadas (por `clientTempId`). Antes se pisaba el hilo
 *   entero y esas burbujas desaparecían: la recepcionista creía haber enviado
 *   algo que nunca salió.
 * - Lo que la recepcionista ya había bajado con "Cargar anteriores" se
 *   conserva SOLO si la página nueva se solapa con lo que había (comparten
 *   algún id). Sin solape —más de 50 mensajes nuevos durante un corte de
 *   Realtime— pegar lo viejo dejaría un hueco invisible en el medio, así que
 *   se descarta y el cursor vuelve a salir de la página nueva.
 */
function applyNewestPage(
  c: Conversation,
  page: Message[],
  pageOlderCursor: string | null
): Conversation {
  const pageIds = new Set(page.map((m) => m.id));
  const serverTempIds = new Set(page.map((m) => m.clientTempId).filter(Boolean));
  const localUnsaved = c.messages.filter(
    (m) => isLocalOnly(m) && m.clientTempId && !serverTempIds.has(m.clientTempId)
  );

  let keptOlder: Message[] = [];
  const overlaps = c.messagesLoaded && c.messages.some((m) => pageIds.has(m.id));
  if (overlaps && page.length > 0 && pageOlderCursor) {
    const oldestPageMs = messageMs(page[0]!);
    keptOlder = c.messages.filter(
      (m) => !isLocalOnly(m) && !pageIds.has(m.id) && messageMs(m) <= oldestPageMs
    );
  }

  return {
    ...c,
    messages: [...keptOlder, ...page, ...localUnsaved],
    messagesLoaded: true,
    olderMessagesCursor: keptOlder.length > 0 ? c.olderMessagesCursor ?? null : pageOlderCursor,
  };
}

/**
 * Carga el hilo de la conversación seleccionada desde `GET /api/inbox/messages`
 * —los últimos 50— y lo escribe en el estado compartido marcando
 * `messagesLoaded: true`. `loadOlder` pide la página anterior y la antepone.
 *
 * Devuelve `loadingMessages` (hay un fetch en vuelo) y `messagesError` (el
 * fetch falló). El consumidor usa el primero para tapar el hilo con un
 * skeleton y el segundo para degradar a lo que haya en memoria en vez de
 * quedarse en skeleton permanente.
 */
export function useInboxConversationMessages(
  conversationId: string,
  hotelId: string | null,
  setConversations: Dispatch<SetStateAction<Conversation[]>>,
  /**
   * Cambiarlo fuerza a recargar el hilo aunque siga siendo la misma
   * conversación. Lo usa la recuperación de Realtime: mientras el canal estuvo
   * caído no llegó nada, y sin esto el hilo abierto se queda con un hueco hasta
   * que la recepcionista cambie de chat o refresque.
   */
  reloadToken: number = 0,
  /**
   * Recibe los acuses de cada página que se aplica (abrir, recargar, cargar
   * anteriores). Solo se llama si la página es de la conversación abierta.
   */
  onStatuses?: (statuses: MessageDeliveryReceipt[]) => void
) {
  const onStatusesRef = useRef(onStatuses);
  useEffect(() => {
    onStatusesRef.current = onStatuses;
  }, [onStatuses]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const fetchKeyRef = useRef("");
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    const convId = conversationId.trim();
    const hid = hotelId?.trim() ?? "";
    // Cambió la conversación: una página "anterior" en vuelo ya no aplica.
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!convId || !hid) {
      setLoadingMessages(false);
      setMessagesError(null);
      return;
    }

    const key = `${hid}:${convId}`;
    fetchKeyRef.current = key;
    // Con el signal, el fetch descartado se corta en el servidor en vez de
    // seguir leyendo `Wubby_Whatsapp` para nadie.
    const controller = new AbortController();

    void (async () => {
      setLoadingMessages(true);
      setMessagesError(null);
      try {
        const params = new URLSearchParams({ conversationId: convId, hotelId: hid });
        const res = await fetch(`/api/inbox/messages?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (await res.json()) as MessagesResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "No se pudo cargar el historial");
        }
        if (controller.signal.aborted || fetchKeyRef.current !== key) return;

        const messages = json.messages ?? [];
        const olderCursor =
          json.hasOlder === true && typeof json.olderCursor === "string" ? json.olderCursor : null;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? applyNewestPage(c, messages, olderCursor) : c))
        );
        onStatusesRef.current?.(json.statuses ?? []);
      } catch (e) {
        // Abortado (cambió la conversación, el hotel, o desmontó): la petición
        // quedó obsoleta, no falló. No es un error que deba ver el usuario ni
        // debe apagar el skeleton de un fetch posterior ya en vuelo.
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (!controller.signal.aborted && fetchKeyRef.current === key) {
          console.warn("[useInboxConversationMessages]", e);
          setMessagesError(e instanceof Error ? e.message : "No se pudo cargar el historial");
        }
      } finally {
        if (!controller.signal.aborted && fetchKeyRef.current === key) {
          setLoadingMessages(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [conversationId, hotelId, setConversations, reloadToken]);

  /**
   * "Cargar anteriores": pide los 50 mensajes previos al `cursor` y los
   * antepone. El llamador pasa el cursor que ve en la conversación; si cuando
   * vuelve la respuesta el cursor ya cambió (otra carga ganó, o se recargó el
   * hilo), la página se descarta en vez de duplicar o mezclar tramos.
   *
   * Un fallo no toca el hilo: el botón sigue ahí para reintentar.
   */
  const loadOlder = useCallback(
    async (cursor: string | null | undefined) => {
      const convId = conversationId.trim();
      const hid = hotelId?.trim() ?? "";
      if (!convId || !hid || !cursor || loadingOlderRef.current) return;
      const key = `${hid}:${convId}`;
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      try {
        const params = new URLSearchParams({ conversationId: convId, hotelId: hid, before: cursor });
        const res = await fetch(`/api/inbox/messages?${params}`, { cache: "no-store" });
        const json = (await res.json()) as MessagesResponse;
        if (!res.ok) throw new Error(json.error ?? "No se pudieron cargar los mensajes anteriores");
        if (fetchKeyRef.current !== key) return;

        const older = json.messages ?? [];
        const nextCursor =
          json.hasOlder === true && typeof json.olderCursor === "string" ? json.olderCursor : null;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId || c.olderMessagesCursor !== cursor) return c;
            const known = new Set(c.messages.map((m) => m.id));
            const fresh = older.filter((m) => !known.has(m.id));
            return {
              ...c,
              messages: [...fresh, ...c.messages],
              olderMessagesCursor: nextCursor,
            };
          })
        );
        // Esta página trae sus propios acuses.
        onStatusesRef.current?.(json.statuses ?? []);
      } catch (e) {
        console.warn("[useInboxConversationMessages] anteriores", e);
      } finally {
        if (fetchKeyRef.current === key) {
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        }
      }
    },
    [conversationId, hotelId, setConversations]
  );

  return { loadingMessages, messagesError, loadingOlder, loadOlder };
}
