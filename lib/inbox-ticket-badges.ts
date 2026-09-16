/**
 * Distintivo de solicitud de servicio en la fila de la bandeja.
 *
 * Módulo puro — sin React, sin Supabase, sin red. Decide QUÉ badge le toca a
 * cada conversación a partir de las filas crudas de `service_tickets`; quién
 * las trae y quién las pinta vive afuera.
 *
 * Vive en `lib/` y no dentro de `app/components/` a propósito: lo comparten el
 * route handler que arma la bandeja, el endpoint de refresco y la UI. Si la
 * regla de "cuál gana cuando hay varias" viviera en el componente, el badge del
 * primer render y el del refresco de 60 s podrían no coincidir.
 */

// Imports relativos CON extensión (no `@/…`): este módulo lo cubre
// `node --test`, que no resuelve los alias de `tsconfig.paths`.
import { normalizeArea, type TicketArea } from "./push/audience.ts";
import { parseWhatsappInstantMs } from "./meta-window.ts";
import { esPendiente } from "./service-tickets.ts";

/**
 * Nombre en pantalla de la categoría DENTRO DE LA BANDEJA.
 *
 * No es `CATEGORIA_LABEL` de `service-tickets.ts` y la diferencia es
 * deliberada: allá `otro` se muestra como "Otro", que en una card de la
 * pantalla de Solicitudes tiene sentido porque el título ya dice "Solicitud".
 * Acá el badge está solo en una fila de conversación, y "Otro" no le dice nada
 * a la recepcionista. Por eso `otro` se lee "Solicitud".
 */
export const BADGE_CATEGORIA_LABEL: Readonly<Record<TicketArea, string>> = {
  housekeeping: "Housekeeping",
  mantenimiento: "Mantenimiento",
  room_service: "Room service",
  otro: "Solicitud",
};

/** Lo mínimo de `service_tickets` que necesita el badge. */
export type TicketBadgeRow = {
  id?: string | null;
  conversation_id?: string | null;
  categoria?: string | null;
  habitacion?: string | null;
  estado?: string | null;
  created_at?: string | null;
};

export type InboxTicketBadge = {
  categoria: TicketArea;
  /** Ya resuelto acá para que la UI no vuelva a decidir el copy. */
  label: string;
  /** `null` cuando el ticket no trae habitación: el badge simplemente la omite. */
  habitacion: string | null;
  /** `true` = alguien ya la tomó (`estado = 'en_curso'`). */
  enCurso: boolean;
  /** Cuántas OTRAS solicitudes pendientes tiene la misma conversación. */
  extraCount: number;
};

/**
 * Tope de largo de la habitación en el badge.
 *
 * La columna es texto libre y el engine la llena con lo que el huésped dictó:
 * "302" casi siempre, pero también "la del fondo del segundo piso". El renglón
 * de la fila tiene alto fijo y ancho compartido con el estado y la propiedad,
 * así que un valor largo se recorta acá en vez de empujar el layout.
 */
const HABITACION_MAX_LENGTH = 10;

function normalizeHabitacion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return value.length > HABITACION_MAX_LENGTH ? `${value.slice(0, HABITACION_MAX_LENGTH)}…` : value;
}

/**
 * Texto visible del badge. Sin habitación NO se escribe " · Hab": una habitación
 * ausente no es un dato pendiente que haya que anunciar, es simplemente algo que
 * el huésped no dijo.
 */
export function ticketBadgeText(badge: InboxTicketBadge): string {
  return badge.habitacion ? `${badge.label} · Hab ${badge.habitacion}` : badge.label;
}

/**
 * Lectura completa para lectores de pantalla. Va aparte del texto visible
 * porque el "+N" se pinta como elemento separado y el punto de "en curso" es
 * solo color: sin esto, quien navega con voz oiría "Housekeeping Hab 302" y se
 * perdería las otras dos cosas que la fila sí está diciendo.
 */
export function ticketBadgeAriaLabel(badge: InboxTicketBadge): string {
  const partes = [badge.label];
  if (badge.habitacion) partes.push(`habitación ${badge.habitacion}`);
  partes.push(badge.enCurso ? "en curso" : "abierta");
  if (badge.extraCount > 0) {
    partes.push(badge.extraCount === 1 ? "y 1 solicitud más" : `y ${badge.extraCount} solicitudes más`);
  }
  return partes.join(", ");
}

/**
 * Agrupa las solicitudes pendientes por conversación y deja una sola por fila.
 *
 * Gana la MÁS RECIENTE, al revés que la pantalla de Solicitudes (donde manda la
 * más vieja porque es una lista de trabajo y lo que lleva más rato esperando es
 * lo más urgente). Acá el badge acompaña a una conversación viva: lo que la
 * recepcionista necesita saber al abrirla es de qué le van a hablar ahora, no
 * qué quedó colgado de ayer. Las demás se cuentan en `extraCount` y se ven
 * completas en la pestaña Solicitudes.
 *
 * Una fecha ilegible NO gana el desempate: se queda atrás en vez de colarse
 * arriba como si fuera la más nueva.
 */
export function buildTicketBadgesByConversation(
  rows: readonly TicketBadgeRow[]
): Map<string, InboxTicketBadge> {
  const mejorPorConversacion = new Map<string, { row: TicketBadgeRow; ms: number; total: number }>();

  for (const row of rows) {
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
    // Sin conversación no hay fila a la que pegarle el badge. El ticket existe y
    // se atiende desde Solicitudes, simplemente no tiene dónde mostrarse acá.
    if (!conversationId) continue;
    if (!esPendiente({ estado: row.estado ?? null })) continue;

    const ms = parseWhatsappInstantMs(row.created_at) ?? Number.NEGATIVE_INFINITY;
    const actual = mejorPorConversacion.get(conversationId);

    if (!actual) {
      mejorPorConversacion.set(conversationId, { row, ms, total: 1 });
      continue;
    }

    actual.total += 1;
    // Estrictamente mayor: ante empate se conserva el primero visto, y como la
    // consulta viene ordenada (created_at desc, id desc) el resultado es
    // determinista entre llamadas.
    if (ms > actual.ms) {
      actual.row = row;
      actual.ms = ms;
    }
  }

  const badges = new Map<string, InboxTicketBadge>();
  for (const [conversationId, { row, total }] of mejorPorConversacion) {
    const categoria = normalizeArea(row.categoria);
    badges.set(conversationId, {
      categoria,
      label: BADGE_CATEGORIA_LABEL[categoria],
      habitacion: normalizeHabitacion(row.habitacion),
      enCurso: typeof row.estado === "string" && row.estado.trim() === "en_curso",
      extraCount: total - 1,
    });
  }

  return badges;
}

/** Serializa el mapa para viajar como JSON. */
export function ticketBadgesToRecord(
  badges: ReadonlyMap<string, InboxTicketBadge>
): Record<string, InboxTicketBadge> {
  const record: Record<string, InboxTicketBadge> = {};
  for (const [id, badge] of badges) record[id] = badge;
  return record;
}

function sameBadge(a: InboxTicketBadge | null, b: InboxTicketBadge | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.categoria === b.categoria &&
    a.habitacion === b.habitacion &&
    a.enCurso === b.enCurso &&
    a.extraCount === b.extraCount
  );
}

type BadgeCarrier = { id: string; ticketBadge?: InboxTicketBadge | null };

/**
 * Pega los badges sobre la lista que ya está en pantalla, para el refresco de
 * 60 s. Solo toca `ticketBadge`: todo lo demás de la conversación (mensajes,
 * no leídas, parches de Realtime) queda intacto.
 *
 * Devuelve EL MISMO array cuando nada cambió — que es el caso normal, porque en
 * un hotel sin solicitudes nuevas los 60 s se cumplen sin novedad. Sin esa
 * salida, cada minuto se re-renderizaría la bandeja entera por nada.
 */
export function applyTicketBadges<T extends BadgeCarrier>(
  conversations: T[],
  badgesByConversationId: Readonly<Record<string, InboxTicketBadge>>
): T[] {
  let changed = false;

  const next = conversations.map((conversation) => {
    const incoming = badgesByConversationId[conversation.id] ?? null;
    if (sameBadge(conversation.ticketBadge ?? null, incoming)) return conversation;
    changed = true;
    return { ...conversation, ticketBadge: incoming };
  });

  return changed ? next : conversations;
}
