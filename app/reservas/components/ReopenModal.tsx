"use client";

import { Spinner } from "@/app/components/Spinner";
import { esArchivada } from "@/lib/reservas-estado";
import { formatCOT } from "../lib/formatters";
import type { Reserva } from "../lib/types";

type Props = {
  reserva: Reserva | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * Confirmación de "Volver a pendientes".
 *
 * Existe porque el botón vivía pegado a "Volver a la lista": dos acciones que
 * empiezan igual, una que solo cierra el detalle y otra que le cambia el estado
 * a la reserva. El clic equivocado devolvía a pendientes una reserva que ya
 * estaba subida al PMS, y recepción se enteraba recién al verla reaparecer en
 * la otra pestaña.
 *
 * Mismo patrón que `RejectModal` —mismo velo, misma card, mismos botones— pero
 * sin campo de texto: acá no hay motivo que registrar, solo hay que parar la
 * mano. El texto dice qué va a pasar y que se puede deshacer, para que la
 * confirmación no se lea como una advertencia de algo grave.
 *
 * Con una archivada (reemplazada o cancelada) el texto cambia y sí advierte:
 * devolverla a pendientes revive una reserva vieja que el huésped ya cambió o
 * canceló, y recepción podría subir al PMS algo que nadie quiere.
 */
export function ReopenModal({ reserva, submitting, onClose, onConfirm }: Props) {
  if (!reserva) return null;
  const archivada = esArchivada(reserva.status);

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-[var(--text-primary)]/35 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reservas-reapertura-titulo"
    >
      <div className="w-full max-w-md rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-card)] p-5 shadow-2xl">
        <h2
          id="reservas-reapertura-titulo"
          className="grotesk text-[18px] font-bold tracking-tight text-[var(--text-primary)]"
        >
          Devolver a pendientes la reserva{" "}
          <span className="ibx-mono text-[16px] text-[var(--accent)]">
            {formatCOT(reserva.quote_request_id)}
          </span>
        </h2>
        {archivada ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-primary)]">
              {reserva.status === "reemplazada" ? (
                <>
                  Esta reserva es <strong>vieja</strong>: el huésped pidió otra después y esa es la que
                  vale. Si la devuelves a <strong>Pendientes</strong>, revives las fechas y datos que el
                  huésped ya cambió.
                </>
              ) : (
                <>
                  El huésped <strong>canceló</strong> esta reserva. Si la devuelves a{" "}
                  <strong>Pendientes</strong>, revives una reserva que el huésped ya no quiere.
                </>
              )}
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Hazlo solo si confirmaste con el huésped que la quiere de vuelta.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-primary)]">
              Vuelve a la pestaña <strong>Pendientes</strong> como si nadie la hubiera procesado. Si
              ya la subiste al PMS, va a aparecer otra vez en la lista de trabajo.
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Se puede deshacer: desde Pendientes la marcas como procesada de nuevo.
            </p>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ibx-press grotesk min-h-[42px] rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-4 text-[13.5px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-app)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {archivada ? "No, dejarla archivada" : "No, dejarla procesada"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            aria-busy={submitting}
            className="ibx-press grotesk inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-chip)] bg-[var(--accent)] px-4 text-[13.5px] font-bold text-white shadow-sm hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            {submitting
              ? "Devolviendo…"
              : archivada
                ? "Sí, revivirla en pendientes"
                : "Sí, devolver a pendientes"}
          </button>
        </div>
      </div>
    </div>
  );
}
