"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readStoredActiveHotelId, writeStoredActiveHotelId } from "@/lib/active-hotel-storage";
import { normalizePhoneDigits } from "@/lib/chat-utils";
import { AppShell } from "@/app/components/AppShell";
import { ChatPanel } from "./components/ChatPanel";
import { RejectModal } from "./components/RejectModal";
import { ReservaCard } from "./components/ReservaCard";
import { ReservaDetalle } from "./components/ReservaDetalle";
import { ReopenModal } from "./components/ReopenModal";
import { TabsHeader } from "./components/TabsHeader";
import { useReservas } from "./hooks/useReservas";
import { formatCOT } from "./lib/formatters";
import type { Reserva, ReservasTab } from "./lib/types";

type Toast = {
  id: number;
  type: "success" | "error" | "info";
  message: string;
};

export function ReservasScreen() {
  const [activeTab, setActiveTab] = useState<ReservasTab>("pendientes");
  const [activeHotelId, setActiveHotelId] = useState<string | null>(() => readStoredActiveHotelId());
  const [phoneQuery, setPhoneQuery] = useState("");
  const [selectedReserva, setSelectedReserva] = useState<Reserva | null>(null);
  const [rejectingReserva, setRejectingReserva] = useState<Reserva | null>(null);
  /**
   * Reserva esperando que confirmen la vuelta a pendientes. Igual que el
   * rechazo: el botón del detalle solo abre el diálogo, y quien ejecuta es el
   * "Sí" de adentro.
   */
  const [reopeningReserva, setReopeningReserva] = useState<Reserva | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3500);
  }, []);

  const {
    pendientes,
    procesadas,
    pendingCount,
    loading,
    error,
    availableHotels,
    resolvedActiveHotelId,
    refetch,
    completeReserva,
    rejectReserva,
    reopenReserva,
  } = useReservas({
    activeHotelId,
    onNewReserva: (reserva) => addToast(`Nueva reserva: ${reserva.titular_nombre ?? "Huésped"}`, "info"),
  });

  const scopedHotelId = activeHotelId ?? resolvedActiveHotelId;

  useEffect(() => {
    if (resolvedActiveHotelId && activeHotelId === null) {
      setActiveHotelId(resolvedActiveHotelId);
      writeStoredActiveHotelId(resolvedActiveHotelId);
    }
  }, [resolvedActiveHotelId, activeHotelId]);

  const visibleReservas = activeTab === "pendientes" ? pendientes : procesadas;
  const phoneQueryDigits = normalizePhoneDigits(phoneQuery);
  const filteredReservas = useMemo(() => {
    if (!phoneQueryDigits) return visibleReservas;
    return visibleReservas.filter((reserva) => {
      const reservaPhoneDigits = normalizePhoneDigits(reserva.quote_requests?.sender_phone);
      return reservaPhoneDigits.includes(phoneQueryDigits);
    });
  }, [phoneQueryDigits, visibleReservas]);

  const emptyMessage = activeTab === "pendientes"
    ? "No hay reservas pendientes por procesar."
    : "No hay reservas procesadas recientes.";
  const noPhoneMatchMessage = "No hay reservas que coincidan con ese teléfono.";

  const selectedStillVisible = useMemo(
    () => filteredReservas.some((reserva) => reserva.id === selectedReserva?.id),
    [selectedReserva?.id, filteredReservas]
  );

  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void (async () => {
      try {
        await refetch();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch, refreshing]);

  const handleComplete = async (reserva: Reserva) => {
    setBusyId(reserva.id);
    try {
      await completeReserva(reserva.id);
      if (selectedReserva?.id === reserva.id) setSelectedReserva(null);
      addToast(`Reserva ${formatCOT(reserva.quote_request_id)} marcada como procesada`);
    } catch (e) {
      addToast(e instanceof Error ? e.message : "No se pudo completar la reserva", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast("Datos copiados al portapapeles");
    } catch {
      addToast("No se pudo copiar al portapapeles", "error");
    }
  };

  const handleReject = async (reason: string) => {
    if (!rejectingReserva) return;
    setBusyId(rejectingReserva.id);
    try {
      await rejectReserva(rejectingReserva.id, reason);
      if (selectedReserva?.id === rejectingReserva.id) setSelectedReserva(null);
      addToast(`Reserva ${formatCOT(rejectingReserva.quote_request_id)} rechazada`);
      setRejectingReserva(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : "No se pudo rechazar la reserva", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleReopen = async () => {
    if (!reopeningReserva) return;
    const reserva = reopeningReserva;
    setBusyId(reserva.id);
    try {
      await reopenReserva(reserva.id);
      // La reserva salta a "Pendientes": dejarla seleccionada mostraría un
      // detalle que ya no corresponde a ninguna tarjeta de la lista visible.
      if (selectedReserva?.id === reserva.id) setSelectedReserva(null);
      addToast(`Reserva ${formatCOT(reserva.quote_request_id)} devuelta a pendientes`);
      setReopeningReserva(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : "No se pudo devolver la reserva a pendientes", "error");
    } finally {
      setBusyId(null);
    }
  };

  const detalleAbierto = Boolean(selectedReserva);
  /**
   * La reserva abierta está resolviendo una acción contra el servidor. Es lo que
   * enciende el spinner del botón que se apretó: antes las acciones solo se
   * apagaban y no había forma de distinguir "está enviando" de "se congeló".
   */
  const detalleBusy = Boolean(selectedReserva && busyId === selectedReserva.id);
  const actionDisabled =
    Boolean(selectedReserva && busyId === selectedReserva.id) ||
    Boolean(selectedReserva && activeTab === "pendientes" && selectedReserva.status !== "pendiente");

  return (
    <AppShell hotelId={scopedHotelId}>
    <div className="flex h-full max-h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div className="fixed right-4 top-4 z-[600] flex max-w-[min(100vw-2rem,24rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-[var(--radius-chip)] border px-4 py-3 text-[13px] font-semibold shadow-lg ${
              toast.type === "error"
                ? "border-[var(--accent)] bg-[var(--red-soft)] text-[var(--accent)]"
                : toast.type === "info"
                  ? "border-sky-300 bg-sky-50 text-sky-950"
                  : "border-[var(--success-text)]/40 bg-[var(--success-bg)] text-[var(--success-text)]"
            }`}
            role={toast.type === "error" ? "alert" : "status"}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {error && (
        <div
          className="shrink-0 border-b px-4 py-2 text-center text-[13px]"
          style={{ borderColor: "var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
        >
          {error}
        </div>
      )}

      {/* Una sola cosa a la vez, en todos los tamaños: o la lista a ancho
          completo, o el detalle de la reserva elegida. Las tres columnas fijas
          del rediseño original (lista angosta, detalle, chat) dejaban la lista
          en una tira de 360 px aunque hubiera pantalla de sobra, y recepción
          barre la lista mucho más seguido de lo que abre una reserva. */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4 xl:p-5">
        {detalleAbierto ? (
          /* Abajo de `xl` este contenedor es el único que scrollea y sus dos
             hijos van uno debajo del otro sin encogerse (`max-xl:shrink-0` en
             cada uno): primero el detalle completo y después el chat. Si se los
             deja encoger, el chat se le monta encima al detalle y tapa el
             titular y las stat cards. Desde `xl` van lado a lado y cada uno
             scrollea por su cuenta. */
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scrollbar-app xl:flex-row xl:gap-4 xl:overflow-hidden">
            <ReservaDetalle
              reserva={selectedReserva}
              processed={activeTab === "procesadas"}
              actionDisabled={actionDisabled}
              busy={detalleBusy}
              onBack={() => setSelectedReserva(null)}
              onComplete={(item) => void handleComplete(item)}
              onCopy={(text) => void handleCopy(text)}
              onReject={setRejectingReserva}
              onReopen={setReopeningReserva}
            />
            {/* La `key` por reserva remonta el panel: así el chat vuelve a
                arrancar plegado en el teléfono cada vez que se elige otra. */}
            <ChatPanel key={selectedReserva?.id ?? "sin-reserva"} reserva={selectedReserva} />
          </div>
        ) : (
          /* La lista es CONTENEDOR, así que va en crema: las `ReservaCard` de
              adentro son las que van en blanco y se levantan del fondo
              (docs/REDESIGN.md §2.1). En blanco sobre blanco las cards solo se
              distinguían por el borde y la lista entera se leía como un bloque
              plano. */
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-app)]">
            <TabsHeader
              activeTab={activeTab}
              pendingCount={pendingCount}
              processedCount={procesadas.length}
              refreshing={refreshing}
              onChange={setActiveTab}
              onRefresh={handleRefresh}
            />

            {/* Con la lista a ancho completo el buscador y el hotel entran en la
                misma línea desde `sm`; en el teléfono siguen apilados. */}
            <div className="flex shrink-0 flex-col gap-2.5 border-b border-[var(--border-soft)] px-4 py-3 sm:flex-row sm:items-center">
              <input
                type="search"
                inputMode="tel"
                autoComplete="off"
                value={phoneQuery}
                onChange={(event) => setPhoneQuery(event.target.value)}
                placeholder="Buscar por teléfono…"
                aria-label="Buscar reservas por teléfono"
                className="w-full rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-3.5 py-2.5 text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] transition focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 sm:min-w-0 sm:flex-1"
              />

              {availableHotels.length >= 2 && (
                <div className="relative sm:w-[280px] sm:shrink-0">
                  <span
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px]"
                    aria-hidden
                  >
                    🏨
                  </span>
                  <select
                    id="reservas-active-hotel"
                    aria-label="Hotel activo"
                    value={scopedHotelId ?? ""}
                    onChange={(event) => {
                      const nextHotelId = event.target.value;
                      setActiveHotelId(nextHotelId);
                      writeStoredActiveHotelId(nextHotelId);
                      setSelectedReserva(null);
                    }}
                    className="w-full cursor-pointer appearance-none rounded-[var(--radius-chip)] border border-[var(--border-soft)] bg-[var(--bg-card)] py-2.5 pl-10 pr-10 text-[13.5px] font-semibold text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
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

            <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-app">
              {loading ? (
                <p className="py-12 text-center text-sm text-[var(--text-secondary)]">Cargando reservas...</p>
              ) : filteredReservas.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="max-w-[260px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                    {phoneQueryDigits && visibleReservas.length > 0 ? noPhoneMatchMessage : emptyMessage}
                  </p>
                </div>
              ) : (
                /* Una card por fila, a todo el ancho de la lista. Las tres
                   columnas de antes achicaban cada tarjeta hasta que las fechas
                   y el total se cortaban, y recepción barre esta lista de arriba
                   abajo: leer un renglón por reserva es más rápido que saltar
                   entre tres columnas. */
                <div className="flex flex-col gap-2.5">
                  {filteredReservas.map((reserva) => (
                    <ReservaCard
                      key={reserva.id}
                      reserva={reserva}
                      selected={selectedReserva?.id === reserva.id && selectedStillVisible}
                      onSelect={setSelectedReserva}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <RejectModal
        key={rejectingReserva?.id ?? "closed"}
        reserva={rejectingReserva}
        submitting={Boolean(busyId && busyId === rejectingReserva?.id)}
        onClose={() => setRejectingReserva(null)}
        onConfirm={(reason) => void handleReject(reason)}
      />

      <ReopenModal
        reserva={reopeningReserva}
        submitting={Boolean(busyId && busyId === reopeningReserva?.id)}
        onClose={() => setReopeningReserva(null)}
        onConfirm={() => void handleReopen()}
      />
    </div>
    </AppShell>
  );
}
