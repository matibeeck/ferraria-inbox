"use client";

import { presentacionEstado, type TonoEstado } from "@/lib/reservas-estado";

const CLASES_POR_TONO: Record<TonoEstado, string> = {
  pendiente: "bg-[var(--gold-soft)] text-[var(--gold)]",
  exito: "bg-[var(--success-bg)] text-[var(--success-text)]",
  alerta: "bg-[var(--red-soft)] text-[var(--accent)]",
  neutro: "border border-[var(--border-soft)] bg-[var(--bg-app)] text-[var(--text-secondary)]",
};

/**
 * Estado real de la reserva, siempre a la vista y en texto.
 *
 * No depende de la pestaña abierta: recepción trabaja desde tablets, donde no
 * hay hover, y necesita saber de un vistazo si la reserva ya está en el PMS
 * sin abrir el detalle ni fijarse en qué pestaña está parada.
 *
 * Acepta cualquier valor: un estado que el Inbox no conoce sale como "Otro
 * estado" en gris en vez de tumbar la tarjeta (ver lib/reservas-estado.ts).
 */
export function EstadoBadge({ status }: { status: unknown }) {
  const { label, tono } = presentacionEstado(status);
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${CLASES_POR_TONO[tono]}`}>
      {label}
    </span>
  );
}
