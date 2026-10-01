/**
 * Solicitudes de servicio (`service_tickets`): vocabulario, transiciones de
 * estado y orden. Módulo puro — sin React, sin Supabase, sin red.
 *
 * Vive en `lib/` y no dentro de `app/solicitudes/` a propósito: lo comparten el
 * route handler (que valida la transición en el servidor) y la pantalla (que
 * decide qué botones pintar). Si la regla viviera solo en la UI, un PATCH hecho
 * a mano podría dejar un ticket en un estado que la pantalla no sabe dibujar.
 */

// Imports relativos CON extensión (no `@/…`): este módulo lo cubre
// `node --test`, que no resuelve los alias de `tsconfig.paths`. `tsconfig` tiene
// `allowImportingTsExtensions`, así que el bundler y `tsc` lo aceptan igual.
import { normalizeArea, TICKET_AREAS, type TicketArea } from "./push/audience.ts";
import { parseWhatsappInstantMs } from "./meta-window.ts";

export const SERVICE_TICKETS_TABLE = "service_tickets";

export { TICKET_AREAS, normalizeArea };
export type { TicketArea };

/** Estados posibles de una solicitud. Mismo vocabulario que `service_tickets.estado`. */
export const TICKET_ESTADOS = ["abierto", "en_curso", "resuelto", "cancelado"] as const;
export type TicketEstado = (typeof TICKET_ESTADOS)[number];

export function isTicketEstado(raw: unknown): raw is TicketEstado {
  return typeof raw === "string" && (TICKET_ESTADOS as readonly string[]).includes(raw.trim());
}

/**
 * Estados que siguen exigiendo trabajo de alguien. Es lo que cuenta el badge de
 * la pestaña y lo que trae el filtro "Abiertas".
 */
export const ESTADOS_PENDIENTES: readonly TicketEstado[] = ["abierto", "en_curso"];

/** Nombre en pantalla del estado. Español colombiano, en femenino ("solicitud"). */
export const ESTADO_LABEL: Readonly<Record<TicketEstado, string>> = {
  abierto: "Abierta",
  en_curso: "En curso",
  resuelto: "Resuelta",
  cancelado: "Cancelada",
};

/** Nombre en pantalla de la categoría. `otro` NO se muestra como "Otro" a secas. */
export const CATEGORIA_LABEL: Readonly<Record<TicketArea, string>> = {
  housekeeping: "Housekeeping",
  mantenimiento: "Mantenimiento",
  room_service: "Room service",
  otro: "Otro",
};

/** Filtros de la pantalla. `abiertas` es el default. */
export const SOLICITUDES_FILTROS = ["abiertas", "resueltas", "canceladas", "todas"] as const;
export type SolicitudesFiltro = (typeof SOLICITUDES_FILTROS)[number];

export function isSolicitudesFiltro(raw: unknown): raw is SolicitudesFiltro {
  return typeof raw === "string" && (SOLICITUDES_FILTROS as readonly string[]).includes(raw.trim());
}

export const FILTRO_LABEL: Readonly<Record<SolicitudesFiltro, string>> = {
  abiertas: "Abiertas",
  resueltas: "Resueltas",
  canceladas: "Canceladas",
  todas: "Todas",
};

/**
 * Estados que trae cada filtro. `null` = sin filtro de estado (todas).
 * "Abiertas" incluye `en_curso`: una solicitud que alguien ya tomó sigue sin
 * resolverse, y esconderla haría que el huésped quede esperando sin que aparezca
 * en ninguna pantalla.
 */
export const FILTRO_ESTADOS: Readonly<Record<SolicitudesFiltro, readonly TicketEstado[] | null>> = {
  abiertas: ESTADOS_PENDIENTES,
  resueltas: ["resuelto"],
  canceladas: ["cancelado"],
  todas: null,
};

/**
 * Transiciones permitidas.
 *
 * `resuelto` y `cancelado` son TERMINALES: no hay "reabrir". Es deliberado —
 * reabrir borraría el `resuelto_at` que es el único rastro que tenemos de cuándo
 * se atendió (no hay tabla de auditoría en el inbox). Si algo se resolvió por
 * error, se abre una solicitud nueva y el historial queda entero.
 */
export const TRANSICIONES: Readonly<Record<TicketEstado, readonly TicketEstado[]>> = {
  abierto: ["en_curso", "resuelto", "cancelado"],
  en_curso: ["resuelto", "cancelado"],
  resuelto: [],
  cancelado: [],
};

/**
 * Pedir el estado que la solicitud YA tiene no es un error: es idempotente.
 *
 * Dos personas tocando "Tomar" al mismo tiempo desde dos tablets es lo normal en
 * recepción, y la segunda no puede recibir un error rojo por llegar tarde. Se
 * responde OK sin re-estampar el timestamp, así el `en_curso_at` sigue siendo el
 * de quien lo tomó primero.
 */
export function esCambioRedundante(desde: TicketEstado, hacia: TicketEstado): boolean {
  return desde === hacia;
}

/** ¿Se puede pasar de `desde` a `hacia`? El cambio redundante NO cuenta acá. */
export function esTransicionValida(desde: TicketEstado, hacia: TicketEstado): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

/** Motivo del rechazo, en español, para devolver en el 400. */
export function motivoTransicionInvalida(desde: TicketEstado, hacia: TicketEstado): string {
  if (TRANSICIONES[desde].length === 0) {
    return `La solicitud ya está ${ESTADO_LABEL[desde].toLowerCase()} y no se puede volver a cambiar`;
  }
  return `No se puede pasar de ${ESTADO_LABEL[desde].toLowerCase()} a ${ESTADO_LABEL[hacia].toLowerCase()}`;
}

/**
 * Campos que se escriben al cambiar de estado.
 *
 * El rastro de quién hizo qué vive en la propia fila, igual que `blocked_at` en
 * `conversations` o `completed_at` en `reservas`: no hay tabla de auditoría en
 * este repo. `resolved_by` es la única columna de autoría que existe, así que
 * "quién tomó" la solicitud no queda registrado — solo cuándo.
 */
export function patchParaEstado(
  hacia: TicketEstado,
  opts: { ahora: string; userId: string }
): Record<string, unknown> {
  const base: Record<string, unknown> = { estado: hacia, updated_at: opts.ahora };

  if (hacia === "en_curso") base.en_curso_at = opts.ahora;
  if (hacia === "resuelto") {
    base.resuelto_at = opts.ahora;
    base.resolved_by = opts.userId;
  }
  if (hacia === "cancelado") base.cancelado_at = opts.ahora;

  return base;
}

/** Fila de `service_tickets` tal como la sirve el endpoint. */
export type ServiceTicket = {
  id: string;
  hotel_id: string;
  conversation_id: string | null;
  categoria: string | null;
  descripcion: string | null;
  habitacion: string | null;
  estado: string | null;
  created_at: string | null;
  en_curso_at: string | null;
  resuelto_at: string | null;
  cancelado_at: string | null;
  /**
   * Cuándo se le mandó al huésped el aviso automático de "ya fue atendida".
   * `null` = no se le avisó (desactivado, recepción ya le había escrito, fuera
   * de la ventana de 24 h, o el envío falló). Opcional para no obligar a los
   * llamadores viejos a inventar el campo.
   */
  guest_notified_at?: string | null;
};

/** Estado de la fila, tolerante a basura en la columna. Desconocido → `abierto`. */
export function estadoDe(ticket: Pick<ServiceTicket, "estado">): TicketEstado {
  const value = typeof ticket.estado === "string" ? ticket.estado.trim() : "";
  return isTicketEstado(value) ? (value as TicketEstado) : "abierto";
}

export function esPendiente(ticket: Pick<ServiceTicket, "estado">): boolean {
  return ESTADOS_PENDIENTES.includes(estadoDe(ticket));
}

/**
 * Instante en el que la solicitud dejó de estar pendiente, si ya pasó.
 * Sirve para ordenar el historial por lo más reciente.
 */
function instanteDeCierre(ticket: ServiceTicket): number {
  return (
    parseWhatsappInstantMs(ticket.resuelto_at) ??
    parseWhatsappInstantMs(ticket.cancelado_at) ??
    parseWhatsappInstantMs(ticket.created_at) ??
    0
  );
}

/**
 * Orden de la lista: pendientes arriba y, entre ellas, la MÁS VIEJA primero.
 *
 * Es al revés que el resto del inbox (donde lo nuevo va arriba) y es a propósito:
 * en una lista de trabajo pendiente, lo que lleva más rato esperando es lo más
 * urgente, no lo que acaba de entrar. Lo ya cerrado va abajo y ahí sí lo más
 * reciente primero, porque es historial y se consulta hacia atrás.
 */
export function ordenarTickets(tickets: readonly ServiceTicket[]): ServiceTicket[] {
  return [...tickets].sort((a, b) => {
    const aPendiente = esPendiente(a);
    const bPendiente = esPendiente(b);
    if (aPendiente !== bPendiente) return aPendiente ? -1 : 1;

    if (aPendiente) {
      const aMs = parseWhatsappInstantMs(a.created_at);
      const bMs = parseWhatsappInstantMs(b.created_at);
      // Una fecha ilegible no puede colarse arriba de todo como si fuera la más
      // vieja: se manda al final del grupo en vez de inventarle una antigüedad.
      if (aMs === null || bMs === null) {
        if (aMs === bMs) return 0;
        return aMs === null ? 1 : -1;
      }
      return aMs - bMs;
    }

    return instanteDeCierre(b) - instanteDeCierre(a);
  });
}

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

function plural(cantidad: number, singular: string, pluralForma: string): string {
  return cantidad === 1 ? `hace 1 ${singular}` : `hace ${cantidad} ${pluralForma}`;
}

/**
 * "hace 12 minutos" a partir de un timestamp de la plataforma.
 *
 * Devuelve `null` si la fecha no se puede leer: un dato ausente se omite, no se
 * dibuja como "hace NaN" ni se inventa un "hace un momento" que sería mentira.
 *
 * Nunca usa `new Date(raw)` directo — `parseWhatsappInstantMs` es lo que asume
 * hora de Bogotá cuando el timestamp viene sin zona, que es como los guarda la
 * plataforma. Con `new Date()` crudo, una recepcionista fuera de Colombia vería
 * la antigüedad corrida 5 horas.
 */
export function tiempoTranscurrido(raw: string | null | undefined, nowMs?: number): string | null {
  const ms = parseWhatsappInstantMs(raw);
  if (ms === null) return null;

  const diff = (nowMs ?? Date.now()) - ms;
  // Fecha en el futuro (reloj corrido): se muestra como recién llegada en vez de
  // un "en 3 horas" que no significa nada para quien atiende.
  if (diff < MINUTO) return "recién";

  if (diff < HORA) return plural(Math.floor(diff / MINUTO), "minuto", "minutos");
  if (diff < DIA) return plural(Math.floor(diff / HORA), "hora", "horas");
  return plural(Math.floor(diff / DIA), "día", "días");
}
