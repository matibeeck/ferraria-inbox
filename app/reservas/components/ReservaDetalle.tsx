"use client";

import type { ReactNode, SVGProps } from "react";
import { Spinner } from "@/app/components/Spinner";
import { avatarFlatColors, initials } from "@/lib/avatar";
import { accionesPorEstado, presentacionEstado } from "@/lib/reservas-estado";
import {
  SIN_DATO,
  buildOperaClipboardText,
  formatCOT,
  formatConteo,
  formatFecha,
  formatFechaOpcional,
  formatHabitacionCorta,
  formatSiNo,
  formatTiempoRelativo,
  formatTotalOpcional,
  getQuoteTaxAmounts,
} from "../lib/formatters";
import type { Reserva } from "../lib/types";
import { EstadoBadge } from "./EstadoBadge";

type Props = {
  reserva: Reserva | null;
  actionDisabled: boolean;
  /**
   * Esta reserva está resolviendo una acción contra el servidor. Enciende el
   * spinner de "Completar": las otras dos acciones pasan por un diálogo, y el
   * estado del envío se lee ahí adentro.
   */
  busy?: boolean;
  onBack: () => void;
  onComplete: (reserva: Reserva) => void;
  onCopy: (text: string) => void;
  onReject: (reserva: Reserva) => void;
  onReopen: (reserva: Reserva) => void;
  /** Abre otra reserva en este mismo detalle (el enlace "Reemplazada por…"). */
  onOpenReserva: (reserva: Reserva) => void;
};

function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function IconCopy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75"
      />
    </svg>
  );
}

function IconUndo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"
      />
    </svg>
  );
}

function IconBan(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M5.636 5.636l12.728 12.728" />
    </svg>
  );
}

function IconArrowLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
    </svg>
  );
}

/** Card con el label de sección en monospace mayúscula (docs/REDESIGN.md §6.4). */
function Card({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-card)] p-4 shadow-sm">
      <h3 className="ibx-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
        {titulo}
      </h3>
      <dl className="mt-3">{children}</dl>
    </section>
  );
}

/** Fila del desglose: label a la izquierda, cifra en monospace a la derecha. */
function Fila({
  label,
  value,
  mono = true,
  destacado = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  destacado?: boolean;
}) {
  const vacio = value === SIN_DATO;
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-[5px] ${
        destacado ? "mt-1 border-t border-[var(--border-soft)] pt-2.5" : ""
      }`}
    >
      <dt className="shrink-0 text-[13px] text-[var(--text-secondary)]">{label}</dt>
      <dd
        className={`min-w-0 break-words text-right ${mono && !vacio ? "ibx-mono" : ""} ${
          destacado ? "text-[14.5px] font-bold" : "text-[13px] font-semibold"
        } ${vacio ? "font-normal text-[var(--text-secondary)]" : "text-[var(--text-primary)]"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  const vacio = value === SIN_DATO;
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-4 py-3 shadow-sm">
      <p className="ibx-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
        {label}
      </p>
      <p
        className={`grotesk mt-1.5 truncate text-[17px] ${
          vacio ? "text-[14px] font-medium text-[var(--text-secondary)]" : "font-bold text-[var(--text-primary)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/** "12 oct al 15 oct", o `null` si a la reserva nueva le falta alguna de las dos fechas. */
function rangoFechas(reserva: Reserva): string | null {
  const entrada = reserva.quote_requests?.fecha_entrada;
  const salida = reserva.quote_requests?.fecha_salida;
  if (!entrada || !salida) return null;
  const desde = formatFecha(entrada, salida);
  const hasta = formatFecha(salida, entrada);
  if (desde === "—" || hasta === "—") return null;
  return `${desde} al ${hasta}`;
}

/**
 * Por qué una reserva archivada (o con un estado que el Inbox no conoce) no
 * tiene los botones de siempre. En texto visible, no en un tooltip: si los
 * botones desaparecen sin explicación se lee como que la pantalla se rompió.
 */
function AvisoEstado({
  reserva,
  onOpenReserva,
}: {
  reserva: Reserva;
  onOpenReserva: (reserva: Reserva) => void;
}) {
  const { estado } = presentacionEstado(reserva.status);
  const caja =
    "rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-app)] px-4 py-3 text-[13px] leading-relaxed text-[var(--text-primary)]";
  const detalle = "mt-1 text-[12.5px] text-[var(--text-secondary)]";

  if (estado === "reemplazada") {
    const nueva = reserva.reemplazo ?? null;
    const fechas = nueva ? rangoFechas(nueva) : null;
    return (
      <div className={caja}>
        <p className="font-semibold">
          {nueva ? (
            <>
              Reemplazada por{" "}
              <button
                type="button"
                onClick={() => onOpenReserva(nueva)}
                className="font-semibold text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-hover)]"
              >
                {fechas ? `la reserva del ${fechas}` : "la reserva nueva"}
              </button>
            </>
          ) : (
            "Reemplazada"
          )}
        </p>
        <p className={detalle}>
          El huésped pidió otra reserva en la misma conversación. Esta no hay que subirla al PMS.
        </p>
      </div>
    );
  }

  if (estado === "cancelada") {
    return (
      <div className={caja}>
        <p className="font-semibold">Cancelada</p>
        <p className={detalle}>
          {reserva.completed_at
            ? "Se canceló después de procesarla: si ya está en el PMS, cancélala allá también."
            : "Se canceló antes de procesarla: no hay que subirla al PMS."}
        </p>
      </div>
    );
  }

  if (estado === null) {
    return (
      <div className={caja}>
        <p className="font-semibold">Estado sin reconocer</p>
        <p className={detalle}>
          Esta reserva tiene un estado que el Inbox todavía no reconoce. Por ahora solo puedes copiar
          sus datos.
        </p>
      </div>
    );
  }

  return null;
}

/**
 * Detalle de la reserva seleccionada (docs/REDESIGN.md §6.4 y §6.5).
 *
 * Todo lo que se ve acá viene tal cual de la cotización: acá no se recalcula
 * ni una noche ni un peso. Lo que la cotización no traiga se pinta como "Sin
 * dato" en gris, nunca como cero ni como error.
 */
export function ReservaDetalle({
  reserva,
  actionDisabled,
  busy = false,
  onBack,
  onComplete,
  onCopy,
  onReject,
  onReopen,
  onOpenReserva,
}: Props) {
  // Sin reserva no hay nada que mostrar: el detalle ya no es una columna fija
  // al lado de la lista, se abre encima de ella y solo existe mientras haya una
  // reserva elegida.
  if (!reserva) return null;

  const quote = reserva.quote_requests;
  const nombre = reserva.titular_nombre || "Titular sin nombre";
  const avatar = avatarFlatColors(reserva.id);
  const { subtotalBeforeIva, ivaAmount, totalAmount } = getQuoteTaxAmounts(quote);

  // Los botones salen del estado real de la fila, no de la pestaña: una
  // reemplazada o cancelada no se completa ni se rechaza esté donde esté.
  const acciones = accionesPorEstado(reserva.status);

  const desayuno = quote?.breakfast_included == null ? SIN_DATO : formatSiNo(quote.breakfast_included);
  const mascotas = quote?.pets == null ? SIN_DATO : formatSiNo(quote.pets);

  return (
    // `shrink-0` abajo de `xl`: el contenedor del detalle es una columna flex
    // con scroll y sin esto el navegador comprimía esta sección para meter el
    // chat en pantalla, así que el titular y las cuatro stat cards quedaban
    // debajo del chat en vez de arriba. Desde `xl` el detalle y el chat quedan
    // lado a lado y esta sección toma el ancho sobrante con su propio scroll.
    <section className="flex min-h-0 flex-col gap-3.5 max-xl:shrink-0 xl:min-w-0 xl:flex-1 xl:overflow-y-auto xl:pr-1 scrollbar-app">
      <header className="flex flex-wrap items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="ibx-press flex min-h-[40px] shrink-0 items-center gap-2 rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-3 text-[13px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-app)]"
        >
          <IconArrowLeft className="h-4 w-4" aria-hidden />
          Volver a la lista
        </button>

        <div className="flex w-full min-w-0 items-start gap-3">
          <span
            className="ibx-mono flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] text-[14px] font-bold"
            style={{ background: avatar.bg, color: avatar.fg }}
            aria-hidden
          >
            {initials(nombre)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="grotesk truncate text-[21px] font-bold tracking-tight text-[var(--text-primary)]">
              {nombre}
            </h2>
            <p className="ibx-mono mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
              {reserva.cedula || SIN_DATO} · {reserva.correo || SIN_DATO}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5">
            <EstadoBadge status={reserva.status} />
            <span className="ibx-mono rounded-full bg-[var(--red-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
              {formatCOT(reserva.quote_request_id)}
            </span>
            <span className="ibx-mono text-[11.5px] text-[var(--text-secondary)]">
              {formatTiempoRelativo(reserva.created_at)}
            </span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Entrada" value={formatFechaOpcional(quote?.fecha_entrada, quote?.fecha_salida)} />
        <StatCard label="Salida" value={formatFechaOpcional(quote?.fecha_salida, quote?.fecha_entrada)} />
        <StatCard
          label="Habitación"
          value={formatHabitacionCorta(quote?.num_rooms, quote?.room_type_requested)}
        />
        <StatCard label="Total" value={formatTotalOpcional(totalAmount)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card titulo="Datos del titular">
          <Fila label="Titular" value={reserva.titular_nombre || SIN_DATO} mono={false} />
          <Fila label="Documento" value={reserva.cedula || SIN_DATO} />
          <Fila label="Correo" value={reserva.correo || SIN_DATO} />
          <Fila label="Teléfono" value={quote?.sender_phone || SIN_DATO} />
          <Fila label="Notas" value={reserva.notas?.trim() || "Sin notas"} mono={false} />
        </Card>

        <Card titulo="Cotización">
          <Fila label="Noches" value={formatConteo(quote?.nights)} />
          {/* Una fila por dato. Apareados ("Adultos · Niños", "2 · Sin dato")
              había que adivinar cuál valor era de cuál etiqueta, y con un dato
              ausente en el medio la lectura se volvía ambigua. */}
          <Fila label="Adultos" value={formatConteo(quote?.adults)} />
          <Fila label="Niños" value={formatConteo(quote?.children)} />
          <Fila label="Desayuno" value={desayuno} mono={false} />
          <Fila label="Mascotas" value={mascotas} mono={false} />
          <Fila label="Subtotal sin IVA" value={formatTotalOpcional(subtotalBeforeIva)} />
          <Fila label="IVA 19%" value={formatTotalOpcional(ivaAmount)} />
          <Fila label="Total con IVA" value={formatTotalOpcional(totalAmount)} destacado />
        </Card>
      </div>

      {reserva.status === "rechazada" && reserva.rejection_reason ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--red-soft)] px-4 py-3 text-[13px] leading-relaxed text-[var(--accent)]">
          <span className="font-semibold">Motivo del rechazo:</span> {reserva.rejection_reason}
        </p>
      ) : null}

      <AvisoEstado reserva={reserva} onOpenReserva={onOpenReserva} />

      <div className="flex flex-wrap items-center gap-2 pb-1">
        {/* Acción principal de cada pestaña: es la que lleva el spinner. Mientras
            resuelve cambia también la palabra ("Completando…"), porque un icono
            que gira sin texto no dice qué está pasando. */}
        {acciones.completar && (
          <button
            type="button"
            onClick={() => onComplete(reserva)}
            disabled={actionDisabled}
            aria-busy={busy}
            className="ibx-press grotesk inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-chip)] bg-[var(--accent)] px-4 text-[13.5px] font-bold text-white shadow-sm hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Completando…
              </>
            ) : (
              <>
                <IconCheck className="h-4 w-4" aria-hidden />
                Completar
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onCopy(buildOperaClipboardText(reserva))}
          className="ibx-press grotesk inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-4 text-[13.5px] font-semibold text-[var(--text-primary)] shadow-sm hover:bg-[var(--bg-app)]"
        >
          <IconCopy className="h-4 w-4" aria-hidden />
          Copiar datos
        </button>
        {/* Al extremo derecho y en rojo, en el mismo lugar que ocupa "Rechazar"
            en las pendientes: es la acción que le cambia el estado a una reserva
            ya procesada, no una forma de salir del detalle.

            Antes quedaba pegado a "Copiar datos" y a un cuerpo de distancia de
            "Volver a la lista" del encabezado. Dos botones que empiezan con
            "Volver", uno que solo cierra el detalle y otro que revierte trabajo
            hecho: el clic equivocado devolvía a pendientes una reserva ya
            subida al PMS. Tampoco lleva spinner, porque el estado del envío se
            lee dentro de la confirmación. */}
        {acciones.volverAPendientes && (
          <button
            type="button"
            onClick={() => onReopen(reserva)}
            disabled={actionDisabled}
            className="ibx-press grotesk ml-auto inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-chip)] px-4 text-[13.5px] font-semibold text-[var(--accent)] hover:bg-[var(--red-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconUndo className="h-4 w-4" aria-hidden />
            Volver a pendientes
          </button>
        )}
        {/* Rechazar no lleva spinner: abre el diálogo de motivo, y el estado del
            envío se lee ahí adentro, que es donde está mirando la recepcionista. */}
        {acciones.rechazar && (
          <button
            type="button"
            onClick={() => onReject(reserva)}
            disabled={actionDisabled}
            className="ibx-press grotesk ml-auto inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-chip)] px-4 text-[13.5px] font-semibold text-[var(--accent)] hover:bg-[var(--red-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconBan className="h-4 w-4" aria-hidden />
            Rechazar
          </button>
        )}
      </div>
    </section>
  );
}
