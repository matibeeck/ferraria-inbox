/**
 * Estados de una fila de `public.reservas` y qué puede hacer recepción con cada
 * uno. Módulo hoja, sin imports de alias, para que `node --test` lo cargue.
 *
 * Los escriben dos repos que no comparten tipos: el Inbox (completada,
 * rechazada, pendiente al reabrir) y el engine (pendiente al crear, cancelada
 * cuando el huésped cancela, reemplazada cuando nace otra reserva en la misma
 * conversación). Por eso todo lo que se pinta pasa por `presentacionEstado`,
 * que acepta cualquier valor: si el engine estrena un estado antes que el
 * Inbox, la tarjeta muestra una etiqueta genérica en vez de reventar.
 */

export const RESERVA_ESTADOS = [
  "pendiente",
  "completada",
  "rechazada",
  "reemplazada",
  "cancelada",
] as const;

export type ReservaStatus = (typeof RESERVA_ESTADOS)[number];

/** Estados que van a la pestaña "Archivadas": ya no son trabajo para el PMS. */
export const RESERVA_ESTADOS_ARCHIVADOS = ["reemplazada", "cancelada"] as const;

/** Estados de la pestaña "Procesadas": recepción ya decidió sobre ellas. */
export const RESERVA_ESTADOS_PROCESADOS = ["completada", "rechazada"] as const;

export type TonoEstado = "pendiente" | "exito" | "alerta" | "neutro";

export type PresentacionEstado = {
  /** El estado reconocido, o `null` si el valor no es ninguno de los conocidos. */
  estado: ReservaStatus | null;
  label: string;
  tono: TonoEstado;
};

const PRESENTACION: Record<ReservaStatus, { label: string; tono: TonoEstado }> = {
  pendiente: { label: "Pendiente", tono: "pendiente" },
  completada: { label: "Procesada", tono: "exito" },
  rechazada: { label: "Rechazada", tono: "alerta" },
  reemplazada: { label: "Reemplazada", tono: "neutro" },
  cancelada: { label: "Cancelada", tono: "neutro" },
};

/** Etiqueta para un estado que el Inbox todavía no conoce. Gris, nunca rojo. */
export const LABEL_ESTADO_DESCONOCIDO = "Otro estado";

export function esEstadoConocido(value: unknown): value is ReservaStatus {
  return typeof value === "string" && (RESERVA_ESTADOS as readonly string[]).includes(value);
}

/** Nunca lanza: cualquier valor (null, número, texto nuevo) tiene etiqueta. */
export function presentacionEstado(value: unknown): PresentacionEstado {
  if (esEstadoConocido(value)) {
    return { estado: value, ...PRESENTACION[value] };
  }
  return { estado: null, label: LABEL_ESTADO_DESCONOCIDO, tono: "neutro" };
}

export function esArchivada(value: unknown): boolean {
  return value === "reemplazada" || value === "cancelada";
}

export type AccionesReserva = {
  completar: boolean;
  rechazar: boolean;
  /** "Volver a pendientes". En archivadas exige la confirmación que avisa que revive una reserva vieja. */
  volverAPendientes: boolean;
};

/**
 * Qué botones de cambio de estado tiene la reserva. Depende del estado real de
 * la fila, no de la pestaña en la que esté parada la recepcionista.
 *
 * Un estado desconocido no ofrece ninguna: no sabemos qué significa y
 * cualquier cambio podría pisar algo que escribió el engine.
 */
export function accionesPorEstado(value: unknown): AccionesReserva {
  if (value === "pendiente") return { completar: true, rechazar: true, volverAPendientes: false };
  if (value === "completada" || value === "rechazada" || esArchivada(value)) {
    return { completar: false, rechazar: false, volverAPendientes: true };
  }
  return { completar: false, rechazar: false, volverAPendientes: false };
}
