"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeDeliveryReceipts } from "@/lib/delivery-status";
import type { MessageDeliveryReceipt } from "@/lib/inbox-types";

type StatusesResponse = {
  statuses?: MessageDeliveryReceipt[];
  error?: string;
};

/**
 * Acuses de entrega de Meta —sent, delivered, read, failed— del hilo abierto,
 * indexados por `wamid`.
 *
 * Ya no hace un request propio al abrir: cada página de
 * `GET /api/inbox/messages` trae los acuses de SUS mensajes y el hilo los suma
 * con `mergeReceipts`. Lo único que sigue pegando a
 * `GET /api/conversations/[id]/message-statuses` es `refetch(wamids)`, el
 * refresco de 6 s tras enviar, y solo con los wamids que todavía pueden cambiar.
 *
 * No usa Realtime a propósito: `message_statuses` es service-role only, así que
 * el navegador no puede suscribirse; y un tick que tarda unos segundos en pasar
 * de ✓ a ✓✓ no le cuesta nada a recepción.
 *
 * Consecuencia de no usar Realtime: si el huésped LEE el mensaje mientras la
 * conversación está abierta, el ✓✓ azul no aparece hasta el siguiente envío o
 * hasta reabrir el hilo. Es una subestimación, nunca una sobreestimación, que
 * es el lado seguro del error.
 *
 * Un fallo del refetch se traga en silencio (solo `console.warn`): sin acuses
 * el hilo se sigue viendo, con los salientes en ✓.
 */
export function useMessageDeliveryReceipts(conversationId: string, hotelId: string | null) {
  const [receipts, setReceipts] = useState<Map<string, MessageDeliveryReceipt>>(
    () => new Map()
  );
  const fetchKeyRef = useRef("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const convId = conversationId.trim();
    const hid = hotelId?.trim() ?? "";
    fetchKeyRef.current = convId && hid ? `${hid}:${convId}` : "";
    // Vaciar al cambiar de hilo: si no, se verían por un instante los acuses de
    // la conversación anterior sobre burbujas que no son suyas.
    setReceipts(new Map());
    return () => {
      controllerRef.current?.abort();
    };
  }, [conversationId, hotelId]);

  /**
   * Suma los acuses que trajo una página del hilo. El llamador garantiza que
   * son de la conversación abierta (descarta páginas de un hilo anterior).
   */
  const mergeReceipts = useCallback((incoming: MessageDeliveryReceipt[] | undefined) => {
    if (!incoming || incoming.length === 0) return;
    setReceipts((prev) => mergeDeliveryReceipts(prev, incoming));
  }, []);

  /**
   * Vuelve a pedir los acuses de `wamids`. Se llama tras enviar: Meta tarda
   * unos segundos en mandar el webhook de status, así que el llamador debe
   * espaciarlo.
   */
  const refetch = useCallback(
    async (wamids: string[]) => {
      const convId = conversationId.trim();
      const hid = hotelId?.trim() ?? "";
      if (!convId || !hid || wamids.length === 0) return;
      const key = `${hid}:${convId}`;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const params = new URLSearchParams({ hotelId: hid, wamids: wamids.join(",") });
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(convId)}/message-statuses?${params}`,
          { cache: "no-store", signal: controller.signal }
        );
        const json = (await res.json()) as StatusesResponse;
        if (!res.ok) throw new Error(json.error ?? "No se pudieron cargar los estados de envío");
        if (controller.signal.aborted || fetchKeyRef.current !== key) return;
        mergeReceipts(json.statuses);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.warn("[useMessageDeliveryReceipts]", e);
      }
    },
    [conversationId, hotelId, mergeReceipts]
  );

  return { deliveryReceipts: receipts, mergeReceipts, refetchDeliveryReceipts: refetch };
}
