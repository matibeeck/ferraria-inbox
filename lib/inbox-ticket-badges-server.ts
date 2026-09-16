/**
 * Consulta de las solicitudes pendientes para el badge de la bandeja.
 *
 * Aparte del módulo puro (`inbox-ticket-badges.ts`) porque toca Supabase y
 * `node --test` no puede cargarlo. Aparte del route handler porque lo usan DOS
 * endpoints: el GET de la bandeja (primer render) y el de refresco de 60 s. Si
 * viviera dentro de uno de los dos, el otro acabaría con su propia copia y los
 * filtros podrían divergir en silencio.
 */
import {
  buildTicketBadgesByConversation,
  type InboxTicketBadge,
  type TicketBadgeRow,
} from "@/lib/inbox-ticket-badges";
import { ESTADOS_PENDIENTES, SERVICE_TICKETS_TABLE } from "@/lib/service-tickets";
import type { getSupabaseServerClient } from "@/lib/supabase-server";

const TICKET_BADGE_COLUMNS = "id, conversation_id, categoria, habitacion, estado, created_at";

/**
 * Tope explícito. Son las solicitudes SIN resolver de un hotel: decenas en el
 * peor día realista, muy lejos de esto. Existe para que un hotel con la pestaña
 * Solicitudes abandonada no se lleve una página entera de PostgREST en cada GET
 * de bandeja.
 */
const TICKET_BADGE_LIMIT = 500;

/**
 * UNA consulta por carga de bandeja, no una por conversación.
 *
 * NUNCA tira el GET: si falla, se devuelve el mapa vacío y la bandeja se sirve
 * sin badges. Mismo criterio que `staff_contacts` — el badge es informativo, y
 * que una recepcionista no pueda ver su bandeja porque `service_tickets` falló
 * sería un cambio pésimo.
 */
export async function fetchTicketBadges(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  hotelId: string
): Promise<Map<string, InboxTicketBadge>> {
  const { data, error } = await supabase
    .from(SERVICE_TICKETS_TABLE)
    .select(TICKET_BADGE_COLUMNS)
    .eq("hotel_id", hotelId)
    .in("estado", [...ESTADOS_PENDIENTES])
    .not("conversation_id", "is", null)
    // El orden lo consume el desempate de "la más reciente" en el módulo puro:
    // con `created_at` ilegible o repetido, `id` hace que gane siempre la misma
    // fila entre llamadas y el badge no parpadee entre dos categorías.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(TICKET_BADGE_LIMIT);

  if (error) {
    // Sin PII: solo el hotel y el code. Nada de descripciones ni habitaciones.
    console.error("[inbox] service_tickets", error.code ?? "sin_code", { hotelId });
    return new Map();
  }

  if ((data ?? []).length >= TICKET_BADGE_LIMIT) {
    console.warn("[inbox] solicitudes pendientes en el tope", {
      hotelId,
      fetched: (data ?? []).length,
      limit: TICKET_BADGE_LIMIT,
    });
  }

  return buildTicketBadgesByConversation((data ?? []) as TicketBadgeRow[]);
}

/**
 * Marca las conversaciones que tienen una solicitud pendiente.
 * Muta en sitio: el array lo acaba de construir el handler que la llama.
 */
export function markTicketBadges(
  conversations: { id: string; ticketBadge?: InboxTicketBadge | null }[],
  badges: ReadonlyMap<string, InboxTicketBadge>
): void {
  if (badges.size === 0) return;
  for (const conversation of conversations) {
    const badge = badges.get(conversation.id);
    if (badge) conversation.ticketBadge = badge;
  }
}
