/**
 * Realtime por Broadcast: los cambios de `conversations` y `Wubby_Whatsapp`
 * llegan desde el trigger `broadcast_hotel_changes`
 * (`supabase/migrations/202610030001_realtime_broadcast.sql`), que llama a
 * `realtime.broadcast_changes` sobre el topic privado `hotel:<hotel_id>`.
 *
 * El `payload` de cada mensaje trae `{ table, schema, operation, record,
 * old_record }`. Este módulo lo traduce a la forma `{ eventType, new, old }`
 * que ya consumen los handlers de la bandeja. Módulo puro, sin Supabase.
 */

export type RowChangeEvent = "INSERT" | "UPDATE" | "DELETE";

export const ROW_CHANGE_EVENTS: readonly RowChangeEvent[] = ["INSERT", "UPDATE", "DELETE"];

/**
 * Cambio de fila. A diferencia de postgres_changes, el trigger ve la fila
 * COMPLETA: `old` de un UPDATE o DELETE trae todas las columnas, no solo la PK.
 * En INSERT `old` es `null`; en DELETE `new` es `null`.
 */
export type RowChange<T> = {
  eventType: RowChangeEvent;
  new: T | null;
  old: Partial<T> | null;
};

/** Topic privado del hotel; la policy de `realtime.messages` lo autoriza. */
export function hotelRealtimeTopic(hotelId: string): string {
  return `hotel:${hotelId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Traduce el `payload` de un broadcast a `{ table, change }`. Devuelve `null`
 * si el mensaje no tiene la forma de `realtime.broadcast_changes`.
 */
export function toRowChange(
  event: RowChangeEvent,
  raw: unknown
): { table: string; change: RowChange<Record<string, unknown>> } | null {
  const body = asRecord(raw);
  if (!body || typeof body.table !== "string") return null;
  return {
    table: body.table,
    change: {
      eventType: event,
      new: asRecord(body.record),
      old: asRecord(body.old_record),
    },
  };
}
