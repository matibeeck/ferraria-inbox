"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { followupReloadDelayMs } from "@/lib/followup-refresh";
import { createClient } from "@/lib/supabase/client";

type FollowupRow = {
  conversation_id: string;
  quote_created_at: string;
  quote_request_id: string;
  stage: string;
};

export type FollowupTimerEntry = {
  quoteCreatedAt: string;
  quoteRequestId: string;
  stage: string;
};

export type UseFollowupTimersResult = {
  followups: Map<string, FollowupTimerEntry>;
  removeFollowup: (conversationId: string) => void;
  /**
   * Pide recargar la lista de seguimientos. Lo dispara Realtime cuando cambia
   * el estado de cotización/seguimiento de una conversación. Varias llamadas
   * seguidas se juntan en una sola recarga.
   */
  refreshFollowups: () => void;
};

/**
 * Antes esto era un poll del RPC `get_pending_followups` cada 60 s por pestaña
 * abierta, incluidas las pestañas en segundo plano: 1,27 millones de llamadas
 * acumuladas en la base. Ahora se carga por evento:
 *
 * - al montar;
 * - al volver a la pestaña, si la última carga tiene más de 60 s;
 * - cuando Realtime avisa que cambió la cotización o el seguimiento de una
 *   conversación (`refreshFollowups`, con debounce);
 * - y un respaldo cada 10 min, solo con la pestaña visible, por si se perdió
 *   algún evento.
 *
 * La cuenta regresiva en pantalla NO depende de esto: `FollowupTimer` la
 * calcula en el cliente a partir de `quoteCreatedAt`.
 */
const VISIBILITY_MIN_AGE_MS = 60 * 1000;
const FALLBACK_REFRESH_MS = 10 * 60 * 1000;
/** Junta ráfagas de eventos (p. ej. varios UPDATE de la misma cotización). */
const EVENT_DEBOUNCE_MS = 5000;
/**
 * Espacio mínimo entre dos recargas disparadas por evento. Aunque Realtime no
 * pare de avisar, el RPC no corre más de una vez cada 30 s por pestaña.
 */
const EVENT_MIN_GAP_MS = 30 * 1000;

function buildFollowupMap(rows: FollowupRow[] | null): Map<string, FollowupTimerEntry> {
  const next = new Map<string, FollowupTimerEntry>();

  for (const row of rows ?? []) {
    if (!row.conversation_id || !row.quote_created_at) continue;
    next.set(row.conversation_id, {
      quoteCreatedAt: row.quote_created_at,
      quoteRequestId: row.quote_request_id,
      stage: row.stage,
    });
  }

  return next;
}

export function useFollowupTimers(): UseFollowupTimersResult {
  const [followups, setFollowups] = useState<Map<string, FollowupTimerEntry>>(() => new Map());
  /** Momento de la última carga que terminó (bien o mal). 0 = nunca. */
  const lastLoadAtRef = useRef(0);
  /**
   * Número de la carga más reciente que se disparó. Una respuesta que vuelve
   * cuando ya salió otra carga más nueva se descarta: si no, una respuesta lenta
   * podría pisar datos más frescos.
   */
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  const removeFollowup = useCallback((conversationId: string) => {
    setFollowups((prev) => {
      if (!prev.has(conversationId)) return prev;
      const next = new Map(prev);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const loadFollowups = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_pending_followups");
      if (!mountedRef.current || seq !== loadSeqRef.current) return;

      if (error) {
        console.warn("[useFollowupTimers] RPC get_pending_followups falló", error.code ?? "sin_code");
        setFollowups(new Map());
        return;
      }
      setFollowups(buildFollowupMap((data ?? []) as FollowupRow[]));
    } catch (e) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      console.warn("[useFollowupTimers] No se pudieron cargar follow-ups", e);
      setFollowups(new Map());
    } finally {
      if (seq === loadSeqRef.current) lastLoadAtRef.current = Date.now();
    }
  }, []);

  const refreshFollowups = useCallback(() => {
    // Ya hay una recarga programada: el evento nuevo se sube a esa. No se
    // reprograma, para que una ráfaga sin pausas no la posponga para siempre.
    if (debounceTimerRef.current != null) return;
    const delay = followupReloadDelayMs({
      nowMs: Date.now(),
      lastLoadAtMs: lastLoadAtRef.current,
      debounceMs: EVENT_DEBOUNCE_MS,
      minGapMs: EVENT_MIN_GAP_MS,
    });
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void loadFollowups();
    }, delay);
  }, [loadFollowups]);

  useEffect(() => {
    mountedRef.current = true;
    void loadFollowups();

    const onVisible = () => {
      if (document.hidden) return;
      if (Date.now() - lastLoadAtRef.current < VISIBILITY_MIN_AGE_MS) return;
      void loadFollowups();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Respaldo: solo con la pestaña a la vista. Una pestaña oculta no pinta
    // nada; al volver, `onVisible` la pone al día.
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      void loadFollowups();
    }, FALLBACK_REFRESH_MS);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(intervalId);
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [loadFollowups]);

  return { followups, removeFollowup, refreshFollowups };
}
