"use client";

import { avatarFlatColors, initials } from "@/lib/avatar";
import {
  SIN_DATO,
  formatCOT,
  formatFechaOpcional,
  formatHabitacionCorta,
  formatTiempoRelativo,
  formatTotalOpcional,
  getQuoteTaxAmounts,
} from "../lib/formatters";
import type { Reserva } from "../lib/types";
import { EstadoBadge } from "./EstadoBadge";

type Props = {
  reserva: Reserva;
  selected: boolean;
  onSelect: (reserva: Reserva) => void;
};

/**
 * Un dato de la card: la etiqueta arriba y el valor debajo.
 *
 * Antes iban en la misma línea, empujados a los extremos. Con la card a ancho
 * completo eso dejaba un vacío enorme entre "Total" y su cifra, y el ojo tenía
 * que cruzar la card entera para aparearlos.
 */
function Dato({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const vacio = value === SIN_DATO;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11.5px] leading-none text-[var(--text-secondary)]">{label}</span>
      <span
        className={`truncate text-[13.5px] font-semibold ${mono && !vacio ? "ibx-mono" : ""} ${
          vacio ? "font-normal text-[var(--text-secondary)]" : "text-[var(--text-primary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Tarjeta de la lista de Reservas (docs/REDESIGN.md §6.3).
 *
 * Solo resume y selecciona: el detalle completo y las acciones viven en el
 * panel del centro, para que la lista se pueda barrer de un vistazo desde una
 * tablet sin scroll infinito.
 */
export function ReservaCard({ reserva, selected, onSelect }: Props) {
  const quote = reserva.quote_requests;
  const nombre = reserva.titular_nombre || "Titular sin nombre";
  const cot = formatCOT(reserva.quote_request_id);
  const { totalAmount } = getQuoteTaxAmounts(quote);
  const avatar = avatarFlatColors(reserva.id);

  return (
    <article>
      {/* `ibx-lift`: al pasar el mouse la card se levanta dos píxeles y toma la
          sombra grande, y al apretarla vuelve a apoyarse. La card es ancha, así
          que el cambio de borde solo —que es lo que había— se perdía a lo largo
          de toda la fila. */}
      <button
        type="button"
        onClick={() => onSelect(reserva)}
        aria-current={selected ? "true" : undefined}
        className={`ibx-lift w-full rounded-[var(--radius-card)] border bg-[var(--bg-card)] p-4 text-left shadow-sm ${
          selected
            ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
            : "border-[var(--border-soft)] hover:border-[var(--text-secondary)]/55"
        }`}
      >
        <div className="flex items-start gap-3.5">
          <span
            className="ibx-mono flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] text-[14px] font-bold"
            style={{ background: avatar.bg, color: avatar.fg }}
            aria-hidden
          >
            {initials(nombre)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="grotesk truncate text-[15.5px] font-semibold text-[var(--text-primary)]">
              {nombre}
            </p>
            <p className="ibx-mono mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
              {cot} · {formatTiempoRelativo(reserva.created_at)}
            </p>
          </div>
          <EstadoBadge status={reserva.status} />
        </div>

        {/* Con la card a ancho completo los cuatro datos entran en un renglón
            desde `sm`: se leen de corrido en vez de en dos filas apretadas. En
            el teléfono siguen de a dos. */}
        <div className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-[var(--border-soft)] pt-3 sm:grid-cols-4">
          <Dato label="Entrada" value={formatFechaOpcional(quote?.fecha_entrada, quote?.fecha_salida)} />
          <Dato label="Salida" value={formatFechaOpcional(quote?.fecha_salida, quote?.fecha_entrada)} />
          <Dato
            label="Habitación"
            value={formatHabitacionCorta(quote?.num_rooms, quote?.room_type_requested)}
          />
          <Dato label="Total" value={formatTotalOpcional(totalAmount)} mono />
        </div>
      </button>
    </article>
  );
}
