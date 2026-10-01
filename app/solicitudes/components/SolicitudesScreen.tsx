"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/app/components/AppShell";
import { readStoredActiveHotelId, writeStoredActiveHotelId } from "@/lib/active-hotel-storage";
import { mensajeAvisoParaRecepcion } from "@/lib/aviso-cierre";
import {
  ESTADO_LABEL,
  FILTRO_LABEL,
  estadoDe,
  type ServiceTicket,
  type SolicitudesFiltro,
  type TicketEstado,
} from "@/lib/service-tickets";
import { useSolicitudes } from "../hooks/useSolicitudes";
import { ConfirmarCancelacion } from "./ConfirmarCancelacion";
import { TicketCard } from "./TicketCard";

type Toast = { id: number; tipo: "ok" | "error"; mensaje: string };

/**
 * Chips de la pantalla (docs/REDESIGN.md §7.2): Abiertas, En curso, Resueltas,
 * Todas.
 *
 * No son los mismos que los filtros del endpoint. "Abiertas" del servidor trae
 * abiertas Y en curso juntas (una solicitud tomada sigue pendiente), así que los
 * dos primeros chips piden ese mismo filtro y se separan acá, en pantalla, por
 * estado. Es un recorte de UI: no toca el hook ni el endpoint.
 *
 * Las canceladas ya no tienen chip propio — el spec define estos cuatro — pero
 * siguen visibles dentro de "Todas", que es donde se consulta el historial.
 */
type Chip = "abiertas" | "en_curso" | "resueltas" | "todas";

const CHIPS: readonly {
  id: Chip;
  label: string;
  filtro: SolicitudesFiltro;
  soloEstado: TicketEstado | null;
}[] = [
  { id: "abiertas", label: FILTRO_LABEL.abiertas, filtro: "abiertas", soloEstado: "abierto" },
  { id: "en_curso", label: ESTADO_LABEL.en_curso, filtro: "abiertas", soloEstado: "en_curso" },
  { id: "resueltas", label: FILTRO_LABEL.resueltas, filtro: "resueltas", soloEstado: null },
  { id: "todas", label: FILTRO_LABEL.todas, filtro: "todas", soloEstado: null },
];

const VACIO: Readonly<Record<Chip, { titulo: string; detalle: string }>> = {
  abiertas: {
    titulo: "No hay solicitudes abiertas",
    detalle:
      "Acá van apareciendo los pedidos que los huéspedes hacen por WhatsApp: toallas, aire acondicionado, room service. La lista se actualiza sola.",
  },
  en_curso: {
    titulo: "No hay solicitudes en curso",
    detalle: "Acá quedan las que alguien ya tomó y todavía no marca como resueltas.",
  },
  resueltas: {
    titulo: "Todavía no hay solicitudes resueltas",
    detalle: "Cuando marques una como resuelta, la vas a encontrar acá.",
  },
  todas: {
    titulo: "Todavía no hay solicitudes",
    detalle:
      "Acá van apareciendo los pedidos que los huéspedes hacen por WhatsApp: toallas, aire acondicionado, room service. La lista se actualiza sola.",
  },
};

export function SolicitudesScreen() {
  const searchParams = useSearchParams();
  const ticketIdBuscado = searchParams.get("ticketId")?.trim() ?? "";

  const [chip, setChip] = useState<Chip>("abiertas");
  const [activeHotelId, setActiveHotelId] = useState<string | null>(() => readStoredActiveHotelId());
  const [cancelando, setCancelando] = useState<ServiceTicket | null>(null);
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const avisar = useCallback(
    (mensaje: string, tipo: Toast["tipo"] = "ok", duracionMs = 3500) => {
      const id = Date.now() + Math.random();
      setToasts((previos) => [...previos, { id, tipo, mensaje }]);
      window.setTimeout(() => setToasts((previos) => previos.filter((t) => t.id !== id)), duracionMs);
    },
    []
  );

  const chipActivo = CHIPS.find((c) => c.id === chip) ?? CHIPS[0];

  const {
    solicitudes,
    estado,
    error,
    availableHotels,
    resolvedActiveHotelId,
    cambiarEstado,
  } = useSolicitudes({ activeHotelId, filtro: chipActivo.filtro });

  const scopedHotelId = activeHotelId ?? resolvedActiveHotelId;

  const visibles = useMemo(() => {
    const soloEstado = chipActivo.soloEstado;
    if (!soloEstado) return solicitudes;
    return solicitudes.filter((ticket) => estadoDe(ticket) === soloEstado);
  }, [solicitudes, chipActivo.soloEstado]);

  useEffect(() => {
    if (resolvedActiveHotelId && activeHotelId === null) {
      setActiveHotelId(resolvedActiveHotelId);
      writeStoredActiveHotelId(resolvedActiveHotelId);
    }
  }, [resolvedActiveHotelId, activeHotelId]);

  /**
   * Deep-link del push (`/solicitudes?ticketId=…`).
   *
   * Si la solicitud no está en la lista visible puede ser que ya la resolvieran,
   * así que se pasa UNA sola vez al chip "Todas" antes de darla por perdida.
   * Si tampoco está ahí (es de otro hotel, o no existe), no pasa nada: la
   * pantalla se comporta como una lista normal en vez de mostrar un error por
   * algo que el usuario no puede arreglar.
   */
  const yaBusqueEnTodas = useRef(false);
  const yaHiceScroll = useRef(false);

  useEffect(() => {
    if (!ticketIdBuscado || estado !== "lista") return;
    const encontrada = visibles.some((t) => t.id === ticketIdBuscado);

    if (!encontrada && !yaBusqueEnTodas.current && chip !== "todas") {
      yaBusqueEnTodas.current = true;
      setChip("todas");
      return;
    }
    if (!encontrada || yaHiceScroll.current) return;

    yaHiceScroll.current = true;
    const nodo = document.getElementById(`solicitud-${ticketIdBuscado}`);
    nodo?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [ticketIdBuscado, estado, visibles, chip]);

  const aplicarCambio = async (ticket: ServiceTicket, nuevoEstado: TicketEstado) => {
    setOcupadoId(ticket.id);
    try {
      const aviso = await cambiarEstado(ticket.id, nuevoEstado);
      if (nuevoEstado === "en_curso") avisar("Solicitud tomada");
      if (nuevoEstado === "resuelto") {
        // El cierre ya quedó guardado pase lo que pase con el aviso; por eso el
        // toast verde va siempre y el resultado del WhatsApp va como segunda
        // línea propia, más tiempo en pantalla para que alcance a leerse. Solo
        // un envío fallido va en rojo: es lo único que pide que alguien actúe.
        avisar("Solicitud resuelta");
        if (aviso) {
          avisar(
            mensajeAvisoParaRecepcion(aviso),
            aviso.motivo === "envio_fallido" ? "error" : "ok",
            6000
          );
        }
      }
      if (nuevoEstado === "cancelado") avisar("Solicitud cancelada");
      setCancelando(null);
    } catch (e) {
      avisar(e instanceof Error ? e.message : "No se pudo actualizar la solicitud", "error");
    } finally {
      setOcupadoId(null);
    }
  };

  const vacio = VACIO[chip];

  return (
    <AppShell hotelId={scopedHotelId}>
    <div className="flex h-full max-h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div className="fixed right-4 top-4 z-[600] flex max-w-[min(100vw-2rem,24rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tipo === "error" ? "alert" : "status"}
            className={`rounded-[var(--radius-chip)] border px-4 py-3 text-[13px] font-semibold shadow-lg ${
              toast.tipo === "error"
                ? "border-[var(--accent)] bg-[var(--red-soft)] text-[var(--accent)]"
                : "border-[var(--success-text)]/40 bg-[var(--success-bg)] text-[var(--success-text)]"
            }`}
          >
            {toast.mensaje}
          </div>
        ))}
      </div>

      {estado === "error" && error && (
        <div
          className="shrink-0 border-b px-4 py-2 text-center text-[13px]"
          style={{ borderColor: "var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
        >
          {error}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto scrollbar-app p-4 lg:p-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          {/* Encabezado de la pantalla (docs/REDESIGN.md §7.1). Reemplaza a la
              barra roja superior: el logo y los controles de cuenta ya viven en
              el sidebar. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="grotesk text-[19px] font-bold tracking-tight text-[var(--text-primary)]">
                Tickets de servicio
              </h1>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                Solicitudes de los huéspedes detectadas por la IA — mantenimiento, room service,
                housekeeping.
              </p>
            </div>

            {availableHotels.length >= 2 && (
              <div className="relative w-full sm:w-auto">
                <span
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px]"
                  aria-hidden
                >
                  🏨
                </span>
                <select
                  id="solicitudes-hotel"
                  aria-label="Hotel activo"
                  value={scopedHotelId ?? ""}
                  onChange={(event) => {
                    setActiveHotelId(event.target.value);
                    writeStoredActiveHotelId(event.target.value);
                  }}
                  className="w-full cursor-pointer appearance-none rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] py-2.5 pl-10 pr-10 text-[13.5px] font-semibold text-[var(--text-primary)] shadow-sm focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 sm:w-[240px]"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%238a857c'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 0.75rem center",
                    backgroundSize: "1rem",
                  }}
                >
                  {availableHotels.map((hotel) => (
                    <option key={hotel.id} value={hotel.id}>
                      {hotel.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <nav className="flex flex-wrap gap-2" aria-label="Filtrar solicitudes">
            {CHIPS.map((opcion) => {
              const activo = opcion.id === chip;
              return (
                <button
                  key={opcion.id}
                  type="button"
                  onClick={() => setChip(opcion.id)}
                  aria-current={activo ? "page" : undefined}
                  className={`grotesk min-h-[44px] rounded-[var(--radius-chip)] px-4 text-[13.5px] font-semibold transition ${
                    activo
                      ? "bg-[var(--text-primary)] text-[var(--bg-card)] shadow-sm"
                      : "border border-[var(--border-soft)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {opcion.label}
                </button>
              );
            })}
          </nav>

          {estado === "cargando" && (
            <p className="py-12 text-center text-[14px] text-[var(--text-secondary)]">
              Cargando solicitudes...
            </p>
          )}

          {estado === "sin-acceso" && (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-card)] p-8 text-center shadow-sm">
              <p className="grotesk text-[16px] font-bold text-[var(--text-primary)]">
                Tu usuario todavía no tiene acceso a las solicitudes
              </p>
              <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--text-secondary)]">
                Pídele a un administrador que revise tu perfil y el hotel al que estás asignado.
              </p>
            </div>
          )}

          {estado === "lista" && visibles.length === 0 && (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-card)] p-8 text-center shadow-sm">
              <p className="grotesk text-[16px] font-bold text-[var(--text-primary)]">{vacio.titulo}</p>
              <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--text-secondary)]">
                {vacio.detalle}
              </p>
            </div>
          )}

          {/* Grid de dos columnas (§7.3). En móvil y en tablet angosta baja a una
              sola: dos cards de 380px no caben sin partir los botones. */}
          {estado === "lista" && visibles.length > 0 && (
            <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
              {visibles.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  resaltado={Boolean(ticketIdBuscado) && ticket.id === ticketIdBuscado}
                  ocupado={ocupadoId === ticket.id}
                  onCambiarEstado={(item, nuevoEstado) => void aplicarCambio(item, nuevoEstado)}
                  onPedirCancelacion={setCancelando}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <ConfirmarCancelacion
        ticket={cancelando}
        enviando={Boolean(cancelando && ocupadoId === cancelando.id)}
        onCerrar={() => setCancelando(null)}
        onConfirmar={() => {
          if (cancelando) void aplicarCambio(cancelando, "cancelado");
        }}
      />
    </div>
    </AppShell>
  );
}
