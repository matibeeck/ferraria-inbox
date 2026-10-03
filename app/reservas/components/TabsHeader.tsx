"use client";

import type { SVGProps } from "react";
import { Spinner } from "@/app/components/Spinner";
import type { ReservasTab } from "../lib/types";

type Props = {
  activeTab: ReservasTab;
  pendingCount: number;
  processedCount: number;
  archivedCount: number;
  refreshing?: boolean;
  onChange: (tab: ReservasTab) => void;
  onRefresh?: () => void;
};

function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.99v4.99"
      />
    </svg>
  );
}

/**
 * Encabezado de la lista de Reservas (docs/REDESIGN.md §6.1 y §6.2). Es el
 * título de la pantalla: acá vive el nombre de la sección desde que se eliminó
 * la barra roja superior.
 *
 * La pestaña activa se pinta en rojo sobre una píldora blanca, no con fondo
 * rojo: el rojo lleno queda reservado para las acciones (§2.2).
 */
export function TabsHeader({
  activeTab,
  pendingCount,
  processedCount,
  archivedCount,
  refreshing = false,
  onChange,
  onRefresh,
}: Props) {
  const tabs: { id: ReservasTab; label: string; count: number }[] = [
    { id: "pendientes", label: "Pendientes", count: pendingCount },
    { id: "procesadas", label: "Procesadas", count: processedCount },
    // Canceladas por el huésped y reemplazadas por una reserva más nueva: ya no
    // son trabajo para el PMS, pero quedan a mano para consultarlas.
    { id: "archivadas", label: "Archivadas", count: archivedCount },
  ];

  return (
    <div className="shrink-0 border-b border-[var(--border-soft)] px-4 pb-3 pt-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="grotesk text-[19px] font-bold tracking-tight text-[var(--text-primary)]">
            Reservas
          </h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Capturadas por WhatsApp, listas para subir al PMS.
          </p>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label="Actualizar reservas"
            /* `ibx-refresh-hover` gira la ruedita mientras el mouse está encima,
               igual que el botón de refrescar de la bandeja. Mientras refresca
               de verdad el icono se cambia por el spinner, así que el guiño del
               hover no se confunde nunca con "estoy cargando". */
            className="ibx-press ibx-refresh-hover flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-app)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {refreshing ? (
              <Spinner className="h-4 w-4 animate-spin" />
            ) : (
              <IconRefresh className="ibx-refresh-icon h-4 w-4" aria-hidden />
            )}
          </button>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Estado de las reservas"
        className="mt-3 flex gap-1.5 rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-app)] p-1"
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.id)}
              className={`ibx-press grotesk flex min-h-[40px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[13px] sm:px-3 font-semibold ${
                active
                  ? "bg-[var(--bg-card)] text-[var(--accent)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)]/60 hover:text-[var(--text-primary)]"
              }`}
            >
              {tab.label}
              <span
                className={`ibx-mono text-[11px] font-semibold ${
                  active ? "text-[var(--accent)]/70" : "text-[var(--text-secondary)]"
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
