import type { SupabaseClient } from "@supabase/supabase-js";
import { receiptsFromStatusRows, type MessageStatusRow } from "@/lib/delivery-status";
import type { MessageDeliveryReceipt } from "@/lib/inbox-types";

/**
 * `message_statuses` solo es legible con service role: el navegador no puede
 * leerla ni con el JWT del usuario, por eso los acuses viajan por el servidor.
 *
 * El cruce es por `wamid` y no por `conversation_id`: en producción esa columna
 * de `message_statuses` viene NULL en el 100 % de las filas y `hotel_id` en un
 * 16 %. El candado de tenencia es de quien llama: los wamids que entran acá
 * tienen que salir de filas de `Wubby_Whatsapp` ya filtradas por el hotel
 * autorizado, así un wamid ajeno nunca llega al `.in()`.
 */
export const MESSAGE_STATUSES_TABLE = "message_statuses";

/**
 * Tope de wamids por consulta. El `.in()` viaja en la URL de PostgREST y cada
 * wamid mide ~62 caracteres: 100 son ~6 KB.
 */
export const MAX_STATUS_WAMIDS = 100;

/** Wamids únicos y no vacíos de un conjunto de filas o mensajes. */
export function uniqueWamids(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const wamid = typeof value === "string" ? value.trim() : "";
    if (wamid) out.add(wamid);
  }
  return [...out];
}

/**
 * Acuses de Meta para un conjunto de wamids YA AUTORIZADOS. Best-effort: si la
 * consulta falla devuelve `[]` y el hilo se pinta con ✓ ("salió"), que es el
 * lado seguro — nunca tumba la respuesta que lo contiene.
 */
export async function fetchReceiptsForWamids(
  supabase: SupabaseClient,
  wamids: string[]
): Promise<MessageDeliveryReceipt[]> {
  const list = wamids.slice(0, MAX_STATUS_WAMIDS);
  if (list.length === 0) return [];

  const { data, error } = await supabase
    .from(MESSAGE_STATUSES_TABLE)
    .select("wamid, status, error_code, error_title")
    .in("wamid", list);

  if (error) {
    console.error("[message-statuses] lookup statuses", error.code ?? "sin_code");
    return [];
  }
  return receiptsFromStatusRows((data ?? []) as MessageStatusRow[]);
}
