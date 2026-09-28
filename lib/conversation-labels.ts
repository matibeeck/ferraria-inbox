/**
 * Clasificación automática de las conversaciones (`conversation_labels`) tal
 * como la muestra el inbox: el distintivo "Queja reciente" de la fila y el
 * bloque "Historial" de la ficha.
 *
 * Módulo puro — sin React, sin Supabase, sin red. Acá vive TODA la regla de
 * qué cuenta como queja reciente y cómo se lee un tramo en español; quién trae
 * las filas (`conversation-labels-server.ts`) y quién las pinta (la bandeja)
 * viven afuera. Si la regla viviera en el componente, la fila y la ficha
 * podrían contradecirse.
 *
 * Cómo llegan los datos: el engine corta la conversación en TRAMOS (6 h sin
 * mensajes cierra uno) y cada 15 min etiqueta los que ya cerraron. El tramo en
 * curso nunca tiene etiqueta: todo lo de acá habla de tramos anteriores.
 */

// Imports relativos CON extensión (no `@/…`): este módulo lo cubre
// `node --test`, que no resuelve los alias de `tsconfig.paths`.
import { COLOMBIA_TIME_ZONE, parseWhatsappInstantMs } from "./meta-window.ts";

export const CONVERSATION_LABELS_TABLE = "conversation_labels";

/**
 * Versión de la taxonomía que se lee. La MISMA que usa el dashboard (RPC
 * `conversation_label_stats`, default `'v1.1'`). Si el engine sube de versión,
 * hay que cambiarla en los dos repos: mientras tanto el distintivo y el
 * historial quedan vacíos en vez de mezclar dos clasificaciones.
 */
export const LABELS_TAXONOMY_VERSION = "v1.1";

/**
 * Motivos sin un pedido real del huésped. Sus quejas NO cuentan, igual que en
 * los porcentajes del dashboard (`OUT_OF_BASE_MOTIVOS`): si el badge contara
 * quejas que el dashboard descarta, las dos pantallas darían números distintos.
 */
export const MOTIVOS_SIN_PEDIDO: readonly string[] = [
  "iniciado_por_hotel",
  "sin_contenido",
  "spam_otro",
];

/** "Reciente" = el tramo con la queja terminó hace 7 días o menos. */
export const RECENT_COMPLAINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Tramos que muestra el bloque "Historial". */
export const HISTORY_LIMIT = 3;

/**
 * Etiquetas en español, copiadas TAL CUAL de `ferraria-dashboard`
 * (`lib/conversation-stats.ts`). Si allá cambia una, acá también: el mismo
 * tramo no puede llamarse distinto en Reportes y en la bandeja.
 */
export const MOTIVO_LABELS: Readonly<Record<string, string>> = {
  cotizar_reserva_nueva: "Cotizar o reservar",
  reserva_existente_cambio: "Cambios a una reserva",
  cancelacion: "Cancelaciones",
  servicio_estadia: "Servicios durante la estadía",
  factura_postventa: "Facturas y después de la estadía",
  pago_comprobante: "Pagos y comprobantes",
  info_general: "Información general",
  sin_contenido: "Sin un pedido claro",
  spam_otro: "Spam u otros temas",
  iniciado_por_hotel: "Mensajes del hotel sin respuesta",
};

export const RESULTADO_LABELS: Readonly<Record<string, string>> = {
  reservo: "Reservó",
  resuelto_ia: "Lo resolvió el agente",
  cotizo_sin_reservar: "Cotizó y no reservó",
  escalado_ia: "El agente lo pasó a recepción",
  escalado_archivo: "Pasó a recepción por un archivo",
  atendido_humano: "Lo atendió recepción directamente",
  abandonado: "El huésped dejó de responder",
  pendiente_modelo: "Sin clasificar",
  no_aplica: "No aplica",
  sin_respuesta_huesped: "El huésped no respondió",
};

/**
 * Mismo criterio que el dashboard: un código que no está en el mapa se muestra
 * crudo, como señal de que falta traducirlo. Hoy solo lo ve super_admin; antes
 * de abrírselo a recepción hay que revisar este fallback.
 */
export function motivoLabel(code: string | null | undefined): string {
  const value = typeof code === "string" ? code.trim() : "";
  if (!value) return "Sin clasificar";
  return Object.hasOwn(MOTIVO_LABELS, value) ? MOTIVO_LABELS[value]! : value;
}

export function resultadoLabel(code: string | null | undefined): string {
  const value = typeof code === "string" ? code.trim() : "";
  if (!value) return "Sin clasificar";
  return Object.hasOwn(RESULTADO_LABELS, value) ? RESULTADO_LABELS[value]! : value;
}

/** Lo mínimo de `conversation_labels` que usan el badge y el historial. */
export type ConversationLabelRow = {
  conversation_id?: string | null;
  motivo?: string | null;
  resultado?: string | null;
  queja?: boolean | null;
  episode_started_at?: string | null;
  episode_ended_at?: string | null;
};

/**
 * ¿La queja de este tramo cuenta? Solo si es `true` explícito y el tramo tuvo
 * un pedido real. `null` no es queja: ausencia de dato no es estado.
 */
export function isCountedComplaint(row: Pick<ConversationLabelRow, "queja" | "motivo">): boolean {
  if (row.queja !== true) return false;
  const motivo = typeof row.motivo === "string" ? row.motivo.trim() : "";
  return !MOTIVOS_SIN_PEDIDO.includes(motivo);
}

/** Límite inferior de la ventana, como instante ISO (UTC) para la consulta. */
export function recentComplaintSinceIso(nowMs: number): string {
  return new Date(nowMs - RECENT_COMPLAINT_WINDOW_MS).toISOString();
}

/**
 * Conversaciones con una queja que cuenta en un tramo terminado dentro de la
 * ventana. La consulta ya filtra por fecha y motivo; se vuelve a aplicar acá
 * para que la regla quede en UN lugar testeable y no dependa de que el filtro
 * de la base y el de la UI coincidan.
 *
 * Un tramo sin fecha de cierre legible NO enciende el badge.
 */
export function recentComplaintConversationIds(
  rows: readonly ConversationLabelRow[],
  nowMs: number
): Set<string> {
  const since = nowMs - RECENT_COMPLAINT_WINDOW_MS;
  const ids = new Set<string>();
  for (const row of rows) {
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
    if (!conversationId) continue;
    if (!isCountedComplaint(row)) continue;
    const endedMs = parseWhatsappInstantMs(row.episode_ended_at);
    if (endedMs === null || endedMs < since) continue;
    ids.add(conversationId);
  }
  return ids;
}

/**
 * El badge solo se calcula si el usuario tiene la capacidad. Sin ella el
 * cargador ni siquiera se llama: no hay consulta que después haya que ocultar.
 */
export async function recentComplaintsFor(
  capabilities: { verHistorialConversacion: boolean },
  load: () => Promise<Set<string>>
): Promise<Set<string>> {
  if (!capabilities.verHistorialConversacion) return new Set();
  return load();
}

/**
 * Marca `recentComplaint` en las conversaciones de la bandeja.
 * Muta en sitio: el array lo acaba de construir el handler que la llama.
 */
export function markRecentComplaints(
  conversations: { id: string; recentComplaint?: boolean }[],
  ids: ReadonlySet<string>
): void {
  if (ids.size === 0) return;
  for (const conversation of conversations) {
    if (ids.has(conversation.id)) conversation.recentComplaint = true;
  }
}

/** Un tramo del bloque "Historial", ya en español. */
export type ConversationHistoryEpisode = {
  /** Inicio del tramo (ISO). La UI lo pinta como fecha en hora Colombia. */
  startedAt: string | null;
  motivo: string;
  resultado: string;
  /** Misma regla que el badge: solo quejas de tramos con pedido real. */
  queja: boolean;
};

/**
 * Los últimos tramos, del más reciente al más viejo, con tope. Ordena por el
 * cierre del tramo; un tramo sin fecha legible queda al final en vez de
 * colarse arriba.
 */
export function buildConversationHistory(
  rows: readonly ConversationLabelRow[],
  limit: number = HISTORY_LIMIT
): ConversationHistoryEpisode[] {
  return rows
    .map((row) => ({
      row,
      ms:
        parseWhatsappInstantMs(row.episode_ended_at) ??
        parseWhatsappInstantMs(row.episode_started_at) ??
        Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(0, limit))
    .map(({ row }) => ({
      startedAt: typeof row.episode_started_at === "string" ? row.episode_started_at : null,
      motivo: motivoLabel(row.motivo),
      resultado: resultadoLabel(row.resultado),
      queja: isCountedComplaint(row),
    }));
}

function colombiaDayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COLOMBIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Fecha del tramo en hora Colombia: "Hoy", "Ayer" o "24 de sept" (con el año
 * solo si no es el actual). `null` si la fecha no se puede leer: la UI omite el
 * renglón de fecha en vez de inventarla.
 */
export function formatEpisodeDate(iso: string | null, nowMs: number): string | null {
  const ms = parseWhatsappInstantMs(iso);
  if (ms === null) return null;

  const key = colombiaDayKey(ms);
  if (key === colombiaDayKey(nowMs)) return "Hoy";
  if (key === colombiaDayKey(nowMs - 24 * 60 * 60 * 1000)) return "Ayer";

  const sameYear = key.slice(0, 4) === colombiaDayKey(nowMs).slice(0, 4);
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: COLOMBIA_TIME_ZONE,
    day: "numeric",
    month: "short",
    ...(sameYear ? null : { year: "numeric" }),
  }).format(new Date(ms));
}
