"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  type Reserva,
  type ReservaActionResponse,
  type ReservasAvailableHotel,
  type ReservasListResponse,
  type ReservasTab,
} from "../lib/types";

type ReservaRealtimeRow = {
  id: string;
  hotel_id?: string | null;
  status?: string | null;
  titular_nombre?: string | null;
};

function buildReservasUrl(tab: ReservasTab, hotelId: string | null) {
  const params = new URLSearchParams({ tab });
  if (hotelId) {
    params.set("hotelId", hotelId);
  }
  return `/api/reservas?${params.toString()}`;
}

function sortPendientes(list: Reserva[]): Reserva[] {
  return [...list].sort((a, b) => {
    return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
  });
}

function sortProcesadas(list: Reserva[]): Reserva[] {
  return [...list].sort((a, b) => {
    const bTime = b.completed_at ?? b.created_at;
    const aTime = a.completed_at ?? a.created_at;
    return new Date(bTime ?? 0).getTime() - new Date(aTime ?? 0).getTime();
  });
}

function upsertReserva(list: Reserva[], reserva: Reserva, tab: "pendientes" | "procesadas"): Reserva[] {
  const next = list.filter((item) => item.id !== reserva.id);
  const withReserva = [reserva, ...next];
  return tab === "pendientes" ? sortPendientes(withReserva) : sortProcesadas(withReserva);
}

async function fetchReservas(tab: ReservasTab, hotelId: string | null) {
  const response = await fetch(buildReservasUrl(tab, hotelId), { cache: "no-store" });
  const payload = (await response.json()) as ReservasListResponse;
  if (!response.ok) throw new Error(payload.error ?? "No se pudieron cargar las reservas");
  return payload;
}

type UseReservasOptions = {
  activeHotelId?: string | null;
  onNewReserva?: (reserva: Pick<Reserva, "titular_nombre">) => void;
};

export function useReservas(options?: UseReservasOptions) {
  const requestedHotelId = options?.activeHotelId ?? null;
  const [pendientes, setPendientes] = useState<Reserva[]>([]);
  const [procesadas, setProcesadas] = useState<Reserva[]>([]);
  const [archivadas, setArchivadas] = useState<Reserva[]>([]);
  /**
   * Error propio de Archivadas. Va aparte a propósito: es la pestaña nueva y
   * la menos usada, y una falla ahí no puede dejar a recepción sin Pendientes.
   */
  const [archivadasError, setArchivadasError] = useState<string | null>(null);
  const [availableHotels, setAvailableHotels] = useState<ReservasAvailableHotel[]>([]);
  const [resolvedActiveHotelId, setResolvedActiveHotelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onNewReservaRef = useRef(options?.onNewReserva);

  useEffect(() => {
    onNewReservaRef.current = options?.onNewReserva;
  }, [options?.onNewReserva]);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const archivedPromise = fetchReservas("archivadas", requestedHotelId);
      // Se engancha ya para que un rechazo mientras esperamos las otras dos no
      // quede como promesa sin manejar.
      archivedPromise.catch(() => undefined);
      const [pendingPayload, processedPayload] = await Promise.all([
        fetchReservas("pendientes", requestedHotelId),
        fetchReservas("procesadas", requestedHotelId),
      ]);
      setPendientes(pendingPayload.reservas ?? []);
      setProcesadas(processedPayload.reservas ?? []);
      try {
        const archivedPayload = await archivedPromise;
        setArchivadas(archivedPayload.reservas ?? []);
        setArchivadasError(null);
      } catch (e) {
        // En el refresco silencioso se conserva la última lista buena.
        if (!silent) setArchivadas([]);
        setArchivadasError(
          e instanceof Error ? e.message : "No se pudieron cargar las reservas archivadas"
        );
      }
      setAvailableHotels(
        pendingPayload.availableHotels ?? processedPayload.availableHotels ?? []
      );
      setResolvedActiveHotelId(
        pendingPayload.activeHotelId ?? processedPayload.activeHotelId ?? null
      );
      setError(null);
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Error de red");
      } else {
        console.warn("[useReservas] Refresco silencioso falló", e);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [requestedHotelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scopedHotelId = requestedHotelId ?? resolvedActiveHotelId;

  useEffect(() => {
    if (!scopedHotelId) return;

    let supabase: ReturnType<typeof createClient> | null = null;
    let channel: RealtimeChannel | null = null;

    try {
      supabase = createClient();
    } catch (e) {
      console.warn("[reservas realtime] cliente no inicializado", e);
      return;
    }

    const applyRealtimeRow = async (
      payload: RealtimePostgresChangesPayload<Record<string, unknown>>
    ) => {
      const row = payload.new as ReservaRealtimeRow | null;
      if (!row || row.hotel_id !== scopedHotelId) return;

      await load(true);
      if (payload.eventType === "INSERT" && row.status === "pendiente") {
        onNewReservaRef.current?.({ titular_nombre: row.titular_nombre ?? "Huésped" });
      }
    };

    // Mismo patrón que useInboxRealtime: el token de sesión tiene que llegar al
    // socket ANTES de unir el canal. Si se suscribe de inmediato, el canal se
    // une con claims de `anon`, RLS no le devuelve filas de `reservas` y el
    // módulo pierde el "en vivo" sin ningún error.
    let cancelled = false;
    const client = supabase;
    void (async () => {
      let accessToken: string | undefined;
      try {
        const {
          data: { session },
        } = await client.auth.getSession();
        accessToken = session?.access_token;
        if (accessToken) {
          await client.realtime.setAuth(accessToken);
        }
      } catch (e) {
        console.warn("[reservas realtime] no se pudo resolver la sesión", e);
        return;
      }

      // Sin `await` entre esta guarda y la asignación de `channel`: el cleanup
      // no puede colarse en el medio y dejar un canal huérfano.
      if (cancelled || !accessToken) return;

      channel = client
        .channel(`reservas-table-${scopedHotelId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "reservas",
            filter: `hotel_id=eq.${scopedHotelId}`,
          },
          (payload) => void applyRealtimeRow(payload)
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "reservas",
            filter: `hotel_id=eq.${scopedHotelId}`,
          },
          (payload) => void applyRealtimeRow(payload)
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel && supabase) {
        void supabase.removeChannel(channel);
      }
    };
  }, [scopedHotelId, load]);

  const completeReserva = useCallback(async (id: string) => {
    const response = await fetch("/api/reservas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "complete" }),
    });
    const payload = (await response.json()) as ReservaActionResponse;
    if (!response.ok || !payload.reserva) {
      throw new Error(payload.error ?? "No se pudo completar la reserva");
    }
    setPendientes((prev) => prev.filter((item) => item.id !== id));
    setProcesadas((prev) => upsertReserva(prev, payload.reserva!, "procesadas").slice(0, 100));
    return payload.reserva;
  }, []);

  const rejectReserva = useCallback(async (id: string, rejectionReason: string) => {
    const response = await fetch("/api/reservas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reject", rejectionReason }),
    });
    const payload = (await response.json()) as ReservaActionResponse;
    if (!response.ok || !payload.reserva) {
      throw new Error(payload.error ?? "No se pudo rechazar la reserva");
    }
    setPendientes((prev) => prev.filter((item) => item.id !== id));
    setProcesadas((prev) => upsertReserva(prev, payload.reserva!, "procesadas").slice(0, 100));
    return payload.reserva;
  }, []);

  const reopenReserva = useCallback(async (id: string) => {
    const response = await fetch("/api/reservas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reopen" }),
    });
    const payload = (await response.json()) as ReservaActionResponse;
    if (!response.ok || !payload.reserva) {
      throw new Error(payload.error ?? "No se pudo devolver la reserva a pendientes");
    }
    setProcesadas((prev) => prev.filter((item) => item.id !== id));
    setArchivadas((prev) => prev.filter((item) => item.id !== id));
    setPendientes((prev) => upsertReserva(prev, payload.reserva!, "pendientes"));
    return payload.reserva;
  }, []);

  return {
    pendientes,
    procesadas,
    archivadas,
    archivadasError,
    pendingCount: pendientes.length,
    loading,
    error,
    availableHotels,
    resolvedActiveHotelId,
    refetch: load,
    completeReserva,
    rejectReserva,
    reopenReserva,
  };
}
