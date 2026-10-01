"use client";

import Link from "next/link";
import { useState, type SVGProps } from "react";
import { Spinner } from "@/app/components/Spinner";
import { horaAvisoHuesped } from "@/lib/aviso-cierre";
import {
  CATEGORIA_LABEL,
  ESTADO_LABEL,
  estadoDe,
  normalizeArea,
  tiempoTranscurrido,
  type ServiceTicket,
  type TicketArea,
  type TicketEstado,
} from "@/lib/service-tickets";

/**
 * Icono del tipo de solicitud (docs/REDESIGN.md §7.3). Es refuerzo visual para
 * reconocer la card de un vistazo: el tipo SIEMPRE va también escrito al lado,
 * porque un icono solo no se lee en una tablet a media luz.
 */
const CATEGORIA_ICONO: Readonly<Record<TicketArea, string>> = {
  mantenimiento: "🔧",
  room_service: "🍽️",
  housekeeping: "🧹",
  otro: "🛎️",
};

/**
 * Colores del estado (§7.3): abierta roja, en curso ámbar, resuelta verde.
 * El texto SIEMPRE dice el estado en palabras: el color es refuerzo, nunca la
 * única señal (hay tablets con brillo bajo y gente que no distingue estos tonos).
 *
 * "Cancelada" no está en el spec porque no es un estado que se filtre desde los
 * chips; aparece igual dentro de "Todas", así que va en neutro para no competir
 * con los tres que sí exigen lectura.
 */
const ESTADO_CLASES: Readonly<Record<TicketEstado, string>> = {
  abierto: "bg-[var(--red-soft)] text-[var(--accent)]",
  en_curso: "bg-[var(--gold-soft)] text-[var(--gold)]",
  resuelto: "bg-[var(--success-bg)] text-[var(--success-text)]",
  cancelado: "bg-[var(--bg-app)] text-[var(--text-secondary)]",
};

const ESTADO_PUNTO: Readonly<Record<TicketEstado, string>> = {
  abierto: "bg-[var(--accent)]",
  en_curso: "bg-[var(--gold)]",
  resuelto: "bg-[var(--success-text)]",
  cancelado: "bg-[var(--text-secondary)]",
};

const BOTON_BASE =
  "ibx-press grotesk inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[var(--radius-chip)] px-4 text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";

/** Cuál de los tres botones de la card se apretó, para saber dónde va el spinner. */
type AccionEnCurso = "tomar" | "resolver" | "cancelar" | null;

function IconPersona(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a7.5 7.5 0 1115 0"
      />
    </svg>
  );
}

function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l5.25 5.25L19.5 6.75" />
    </svg>
  );
}

function IconChat(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3.75c-4.556 0-8.25 3.03-8.25 6.77 0 1.87.924 3.56 2.418 4.78l-.83 3.45a.4.4 0 00.58.45l3.4-1.79c.85.2 1.75.31 2.682.31 4.556 0 8.25-3.03 8.25-6.77S16.556 3.75 12 3.75z"
      />
    </svg>
  );
}

export function TicketCard({
  ticket,
  resaltado,
  ocupado,
  onCambiarEstado,
  onPedirCancelacion,
}: {
  ticket: ServiceTicket;
  resaltado: boolean;
  ocupado: boolean;
  onCambiarEstado: (ticket: ServiceTicket, estado: TicketEstado) => void;
  onPedirCancelacion: (ticket: ServiceTicket) => void;
}) {
  /**
   * `ocupado` viene de arriba y solo dice "esta solicitud está resolviendo
   * algo", no CUÁL de los tres botones se apretó. Eso se recuerda acá, que es
   * el único lugar que lo sabe, para que el spinner salga en el botón que la
   * recepcionista tocó y no en los tres a la vez.
   */
  const [accionPedida, setAccionPedida] = useState<AccionEnCurso>(null);

  /*
    Se deriva en vez de limpiarse con un efecto: apenas `ocupado` vuelve a
    false el spinner se apaga solo, salga bien o falle la acción. Guardarlo en
    estado y limpiarlo aparte dejaría el botón girando para siempre el día que
    la petición falle.
  */
  const accionEnCurso: AccionEnCurso = ocupado ? accionPedida : null;

  const estado = estadoDe(ticket);
  const area = normalizeArea(ticket.categoria);
  const categoria = CATEGORIA_LABEL[area];
  const habitacion = ticket.habitacion?.trim();
  const desde = tiempoTranscurrido(ticket.created_at);
  const descripcion = ticket.descripcion?.trim();
  const horaAviso = estado === "resuelto" ? horaAvisoHuesped(ticket.guest_notified_at) : null;

  const puedeTomar = estado === "abierto";
  const puedeResolver = estado === "abierto" || estado === "en_curso";
  const puedeCancelar = puedeResolver;
  const cerrada = !puedeResolver;

  return (
    <article
      id={`solicitud-${ticket.id}`}
      className={`flex flex-col rounded-[var(--radius-card)] border bg-[var(--bg-card)] p-4 shadow-sm transition ${
        resaltado || estado === "abierto"
          ? "border-[var(--accent)]/60"
          : "border-[var(--border-soft)]"
      } ${resaltado ? "ring-2 ring-[var(--accent)]/25" : ""}`}
    >
      {resaltado && (
        <p className="mb-3 rounded-[var(--radius-chip)] bg-[var(--red-soft)] px-3 py-2 text-[13px] font-semibold text-[var(--accent)]">
          Esta es la solicitud de la notificación que abriste.
        </p>
      )}

      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-[var(--bg-app)] text-[17px]"
        >
          {CATEGORIA_ICONO[area]}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="grotesk text-[15px] font-bold tracking-tight text-[var(--text-primary)]">
            {categoria}
          </h2>
          {/* El spec pide "Nombre · hace N días", pero la solicitud no trae el
              nombre del huésped: se muestra solo la antigüedad en vez de
              inventar un nombre o pintar un hueco alarmante. Si la fecha
              tampoco se puede leer, la línea entera se omite. */}
          {desde && (
            <p className="ibx-mono mt-0.5 text-[11.5px] text-[var(--text-secondary)]">{desde}</p>
          )}
        </div>

        {/* Sin `shrink-0` a propósito: en una tablet angosta las dos píldoras
            se acomodan una debajo de la otra en vez de empujar la card a scroll
            horizontal. */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {/* Sin número de habitación se dice así, con todas las letras: es un
              dato que falta, no una habitación llamada "—". */}
          <span className="ibx-mono whitespace-nowrap rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)]">
            {habitacion ? `Hab. ${habitacion}` : "Sin habitación"}
          </span>
          <span
            className={`grotesk inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-chip)] px-2.5 py-1 text-[11.5px] font-semibold ${ESTADO_CLASES[estado]}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${ESTADO_PUNTO[estado]}`} aria-hidden />
            {ESTADO_LABEL[estado]}
          </span>
        </div>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-[14.5px] leading-relaxed text-[var(--text-primary)]">
        {descripcion || "La solicitud llegó sin descripción."}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-3">
        {puedeTomar && (
          <button
            type="button"
            disabled={ocupado}
            aria-busy={accionEnCurso === "tomar"}
            onClick={() => {
              setAccionPedida("tomar");
              onCambiarEstado(ticket, "en_curso");
            }}
            className={`${BOTON_BASE} border border-[var(--border-soft)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-app)]`}
          >
            {accionEnCurso === "tomar" ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Tomando…
              </>
            ) : (
              <>
                <IconPersona className="h-4 w-4" aria-hidden />
                Tomar
              </>
            )}
          </button>
        )}

        {puedeResolver && (
          <button
            type="button"
            disabled={ocupado}
            aria-busy={accionEnCurso === "resolver"}
            onClick={() => {
              setAccionPedida("resolver");
              onCambiarEstado(ticket, "resuelto");
            }}
            className={`${BOTON_BASE} bg-[var(--accent)] text-white shadow-sm hover:bg-[var(--accent-hover)]`}
          >
            {accionEnCurso === "resolver" ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                Resolviendo…
              </>
            ) : (
              <>
                <IconCheck className="h-4 w-4" aria-hidden />
                Resolver
              </>
            )}
          </button>
        )}

        {/* Cancelar abre la confirmación, no manda nada: por eso no lleva
            spinner. El estado del envío se lee dentro del diálogo. */}
        {puedeCancelar && (
          <button
            type="button"
            disabled={ocupado}
            onClick={() => {
              setAccionPedida("cancelar");
              onPedirCancelacion(ticket);
            }}
            className={`${BOTON_BASE} bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-app)] hover:text-[var(--text-primary)]`}
          >
            Cancelar
          </button>
        )}

        {/* Cerrada es definitivo: no hay "Reabrir" porque el servidor rechaza
            cualquier cambio sobre una solicitud resuelta o cancelada. En vez de
            un botón que siempre falla, se dice en pantalla qué hacer. */}
        {cerrada && (
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Ya está cerrada. Si vuelve a pasar, abre una solicitud nueva.
          </p>
        )}

        {/* Solo cuando el aviso SÍ salió. Sin marca no se dice nada: puede ser
            que no se haya mandado por cualquiera de los motivos del toast, y
            pintar "no avisado" en cada resuelta vieja sería ruido. */}
        {horaAviso && (
          <p className="ibx-mono text-[12px] font-semibold text-[var(--success-text)]">
            Huésped avisado · {horaAviso}
          </p>
        )}

        {ticket.conversation_id && (
          <Link
            href={`/?conversationId=${encodeURIComponent(ticket.conversation_id)}`}
            className="ibx-press grotesk ml-auto inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-chip)] px-3 text-[13.5px] font-semibold text-[var(--accent)] hover:bg-[var(--red-soft)]"
          >
            <IconChat className="h-4 w-4" aria-hidden />
            Ver conversación
          </Link>
        )}
      </div>
    </article>
  );
}
