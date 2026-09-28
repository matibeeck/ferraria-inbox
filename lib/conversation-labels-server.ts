/**
 * Lecturas de `conversation_labels` para el inbox.
 *
 * La tabla tiene RLS activado y SIN permisos para anon/authenticated: solo se
 * lee con la llave de servicio, así que el aislamiento entre hoteles es 100 %
 * este código. Cada consulta filtra por `hotel_id` en el query mismo y ese
 * `hotel_id` siempre llega ya validado por el endpoint que llama.
 *
 * Aparte del módulo puro (`conversation-labels.ts`) porque toca Supabase y
 * `node --test` no puede cargarlo.
 */
import {
  CONVERSATION_LABELS_TABLE,
  HISTORY_LIMIT,
  LABELS_TAXONOMY_VERSION,
  MOTIVOS_SIN_PEDIDO,
  buildConversationHistory,
  recentComplaintConversationIds,
  recentComplaintSinceIso,
  type ConversationHistoryEpisode,
  type ConversationLabelRow,
} from "@/lib/conversation-labels";
import type { getSupabaseServerClient } from "@/lib/supabase-server";

type ServerClient = ReturnType<typeof getSupabaseServerClient>;

/**
 * Tope explícito. Son las quejas de UNA semana de UN hotel: hoy una decena en
 * el hotel con más. Existe para que un día anómalo del clasificador no se
 * lleve una página entera de PostgREST en cada carga de bandeja.
 */
const RECENT_COMPLAINTS_LIMIT = 500;

/** Lista literal para el filtro `not in` de PostgREST. */
const MOTIVOS_SIN_PEDIDO_FILTER = `(${MOTIVOS_SIN_PEDIDO.join(",")})`;

/**
 * UNA consulta por hotel y por carga de bandeja, no una por conversación: no
 * depende de cuántas filas haya en pantalla, así que también cubre las que
 * llegan después con el scroll.
 *
 * NUNCA tira la bandeja: si falla, devuelve el conjunto vacío y la bandeja se
 * sirve sin el distintivo. Mismo criterio que las solicitudes.
 */
export async function fetchRecentComplaintConversationIds(
  supabase: ServerClient,
  hotelId: string,
  nowMs: number = Date.now()
): Promise<Set<string>> {
  let data: unknown[] | null = null;
  let error: { code?: string } | null = null;
  try {
    ({ data, error } = await supabase
      .from(CONVERSATION_LABELS_TABLE)
      .select("conversation_id, motivo, queja, episode_ended_at")
      .eq("hotel_id", hotelId)
      .eq("taxonomy_version", LABELS_TAXONOMY_VERSION)
      .eq("queja", true)
      .not("motivo", "in", MOTIVOS_SIN_PEDIDO_FILTER)
      .gte("episode_ended_at", recentComplaintSinceIso(nowMs))
      .limit(RECENT_COMPLAINTS_LIMIT));
  } catch {
    // Un fallo de red que se escapara de acá tumbaría el `Promise.all` de la
    // bandeja entera. El distintivo es informativo: se pierde él, nada más.
    error = { code: "excepcion" };
  }

  if (error) {
    // Sin PII: solo el hotel y el code.
    console.error("[inbox] conversation_labels quejas", error.code ?? "sin_code", { hotelId });
    return new Set();
  }

  const rows = (data ?? []) as ConversationLabelRow[];
  if (rows.length >= RECENT_COMPLAINTS_LIMIT) {
    console.warn("[inbox] quejas recientes en el tope", {
      hotelId,
      fetched: rows.length,
      limit: RECENT_COMPLAINTS_LIMIT,
    });
  }

  return recentComplaintConversationIds(rows, nowMs);
}

/**
 * Los últimos tramos etiquetados de UNA conversación, ya en español.
 * `hotelId` tiene que venir de la validación de propiedad de la conversación,
 * nunca del cliente. Si falla, tira: el endpoint responde un error genérico y
 * la ficha pinta su propio aviso sin afectar nada más.
 */
export async function fetchConversationHistory(
  supabase: ServerClient,
  hotelId: string,
  conversationId: string
): Promise<ConversationHistoryEpisode[]> {
  const { data, error } = await supabase
    .from(CONVERSATION_LABELS_TABLE)
    .select("motivo, resultado, queja, episode_started_at, episode_ended_at")
    .eq("hotel_id", hotelId)
    .eq("conversation_id", conversationId)
    .eq("taxonomy_version", LABELS_TAXONOMY_VERSION)
    .order("episode_ended_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    throw new Error(`conversation_labels historial: ${error.code ?? "sin_code"}`);
  }

  return buildConversationHistory((data ?? []) as ConversationLabelRow[]);
}
