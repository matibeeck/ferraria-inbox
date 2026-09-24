import type {
  MessageDeliveryReceipt,
  MessageDeliveryStatus,
  MetaDeliveryStatus,
} from "@/lib/inbox-types";

/**
 * Orden de avance de los acuses de Meta. Sirve para dos cosas: quedarse con el
 * acuse más avanzado cuando hay varios por `wamid`, y decidir el tick.
 *
 * `failed` va aparte, fuera de la escala: no es "menos que sent", es otra rama.
 * Se le da el valor más alto porque un fallo SIEMPRE debe ganar sobre cualquier
 * acuse previo — Meta puede aceptar un mensaje (`sent`) y rechazarlo segundos
 * después, y lo que recepción necesita ver es el rechazo.
 */
const RANK: Record<MetaDeliveryStatus, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

const VALID = new Set<string>(["sent", "delivered", "read", "failed"]);

/** Normaliza el `status` crudo de la tabla; `null` si Meta mandó algo que no conocemos. */
export function toMetaDeliveryStatus(raw: unknown): MetaDeliveryStatus | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return VALID.has(value) ? (value as MetaDeliveryStatus) : null;
}

/**
 * De varios acuses del mismo `wamid`, deja el más avanzado.
 *
 * Hoy `message_statuses` guarda UNA sola fila por wamid (6.008 filas / 6.008
 * wamid distintos, agosto 2026): el engine sobrescribe en vez de acumular. Esta
 * función es la red de seguridad por si eso cambia y la tabla pasa a ser un log
 * de transiciones — sin ella, un `sent` que llegue tarde borraría un `read`.
 *
 * No se desempata por `occurred_at` a propósito: los relojes de Meta y los
 * nuestros no están sincronizados, y el orden lógico de los estados es
 * información más confiable que la marca de tiempo.
 */
export function pickMostAdvancedReceipt(
  a: MessageDeliveryReceipt | undefined,
  b: MessageDeliveryReceipt
): MessageDeliveryReceipt {
  if (!a) return b;
  return RANK[b.status] > RANK[a.status] ? b : a;
}

/**
 * Qué se pinta al lado de la hora en un mensaje saliente.
 *
 * - `pending`  → reloj. La petición de envío sigue en vuelo.
 * - `sent`     → un check. Salió, pero nadie confirmó que llegara.
 * - `delivered`→ doble check. Meta confirma que llegó al teléfono.
 * - `read`     → doble check en azul. El huésped lo abrió.
 * - `failed`   → chip rojo con el motivo (lo resuelve la burbuja aparte).
 */
export type DeliveryTick = "pending" | "sent" | "delivered" | "read" | "failed";

/**
 * Regla central: NUNCA se muestra doble check sin acuse de Meta.
 *
 * El orden de las guardas importa. Un mensaje sin acuse cae siempre en `sent`
 * (un check), no en `pending`: ver el comentario de `MessageDeliveryReceipt`
 * sobre por qué "sin acuse" es el caso normal y no una anomalía.
 */
export function resolveDeliveryTick(
  localStatus: MessageDeliveryStatus,
  receipt: MessageDeliveryReceipt | undefined
): DeliveryTick {
  // El acuse de Meta gana sobre el estado local: el optimista solo sabe si la
  // petición terminó, y Meta sabe si el huésped lo tiene. Gana incluso sobre un
  // `failed` local: si Meta acusó algo, hay `wamid`, y si hay `wamid` el mensaje
  // salió — el fallo local estaría desactualizado.
  if (receipt) return receipt.status;
  // Sin acuse, un fallo local SÍ manda. Es el caso de "preguntamos por
  // `client_temp_id` y la fila no existe": el mensaje no salió y hay que
  // ofrecer reintentar, no dejar la burbuja en ✓ como si hubiera salido.
  if (localStatus === "failed") return "failed";
  if (localStatus === "pending") return "pending";
  return "sent";
}

/** Fila cruda de `message_statuses` (solo las columnas que se piden). */
export type MessageStatusRow = {
  wamid: string | null;
  status: string | null;
  error_code: number | null;
  error_title: string | null;
};

/**
 * Colapsa filas de `message_statuses` a UN acuse por `wamid`, el más avanzado.
 * Hoy la tabla trae una sola fila por wamid, así que esto no descarta nada;
 * existe para que un futuro log de transiciones no rompa el tick.
 *
 * Un status desconocido se descarta: es preferible dejar la burbuja en ✓
 * ("salió") que inventar una entrega a partir de un valor que no sabemos leer.
 */
export function receiptsFromStatusRows(rows: MessageStatusRow[]): MessageDeliveryReceipt[] {
  const byWamid = new Map<string, MessageDeliveryReceipt>();
  for (const row of rows) {
    const wamid = typeof row.wamid === "string" ? row.wamid.trim() : "";
    const status = toMetaDeliveryStatus(row.status);
    if (!wamid || !status) continue;
    byWamid.set(
      wamid,
      pickMostAdvancedReceipt(byWamid.get(wamid), {
        wamid,
        status,
        errorCode: row.error_code ?? null,
        errorTitle: row.error_title ?? null,
      })
    );
  }
  return [...byWamid.values()];
}

/**
 * Suma acuses nuevos a los que ya hay en memoria. Cada página del hilo trae
 * los de SUS mensajes, así que abrir, cargar anteriores y el refetch tras
 * enviar se van acumulando en el mismo mapa en vez de pisarse.
 *
 * Por wamid gana el más avanzado: un refetch que llega tarde con `sent` no
 * puede bajar a ✓ una burbuja que ya estaba en ✓✓ azul.
 *
 * Devuelve el MISMO mapa si no cambió nada, para no re-renderizar el hilo.
 */
export function mergeDeliveryReceipts(
  current: Map<string, MessageDeliveryReceipt>,
  incoming: MessageDeliveryReceipt[]
): Map<string, MessageDeliveryReceipt> {
  let next: Map<string, MessageDeliveryReceipt> | null = null;
  for (const receipt of incoming) {
    const wamid = receipt.wamid?.trim();
    if (!wamid) continue;
    const base = next ?? current;
    const existing = base.get(wamid);
    const winner = pickMostAdvancedReceipt(existing, { ...receipt, wamid });
    if (winner === existing) continue;
    next ??= new Map(current);
    next.set(wamid, winner);
  }
  return next ?? current;
}

/**
 * Wamids de salientes que todavía pueden cambiar de acuse, los más recientes
 * primero y con tope. Es lo que pide el refetch de 6 s tras enviar: `read` y
 * `failed` ya son finales y no hace falta volver a preguntar por ellos.
 */
export function collectPendingReceiptWamids(
  messages: Array<{ sender: string; wamid?: string | null; reactionToWamid?: string | null }>,
  receipts: Map<string, MessageDeliveryReceipt>,
  max: number
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && out.length < max; i -= 1) {
    const m = messages[i]!;
    if (m.sender === "user" || m.reactionToWamid) continue;
    const wamid = m.wamid?.trim();
    if (!wamid || seen.has(wamid)) continue;
    seen.add(wamid);
    const status = receipts.get(wamid)?.status;
    if (status === "read" || status === "failed") continue;
    out.push(wamid);
  }
  return out;
}
