/**
 * Cuánto esperar antes de recargar los seguimientos por un evento de Realtime.
 *
 * Dos frenos, ambos por pestaña:
 * - debounce: una ráfaga de eventos seguidos se junta en una sola recarga;
 * - espacio mínimo entre recargas: aunque los eventos no paren, el RPC
 *   `get_pending_followups` no corre más de una vez cada `minGapMs`.
 *
 * Pura para poder probarla sin React ni timers reales.
 */
export function followupReloadDelayMs(params: {
  nowMs: number;
  lastLoadAtMs: number;
  debounceMs: number;
  minGapMs: number;
}): number {
  const { nowMs, lastLoadAtMs, debounceMs, minGapMs } = params;
  const sinceLast = lastLoadAtMs > 0 ? nowMs - lastLoadAtMs : Number.POSITIVE_INFINITY;
  const untilGap = Math.max(0, minGapMs - sinceLast);
  return Math.max(debounceMs, untilGap);
}
