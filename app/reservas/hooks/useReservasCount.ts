"use client";

import { useCallback, useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function useReservasCount(hotelId: string | null | undefined) {
  const scopedHotelId = typeof hotelId === "string" ? hotelId.trim() : "";
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!scopedHotelId) {
      setCount(0);
      return;
    }
    try {
      const params = new URLSearchParams({ count: "1", hotelId: scopedHotelId });
      const response = await fetch(`/api/reservas?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { count?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "No se pudo cargar el contador");
      setCount(payload.count ?? 0);
    } catch (e) {
      console.warn("[useReservasCount] No se pudo actualizar el contador", e);
    }
  }, [scopedHotelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!scopedHotelId) return;

    let supabase: ReturnType<typeof createClient> | null = null;
    let channel: RealtimeChannel | null = null;

    try {
      supabase = createClient();
    } catch (e) {
      console.warn("[reservas count realtime] cliente no inicializado", e);
      return;
    }

    // Mismo patrón que useInboxRealtime: el token de sesión tiene que llegar al
    // socket ANTES de unir el canal; si no, el canal entra como `anon` y RLS
    // no le entrega ningún evento de `reservas`.
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
        console.warn("[reservas count realtime] no se pudo resolver la sesión", e);
        return;
      }

      if (cancelled || !accessToken) return;

      channel = client
        .channel(`reservas-count-${scopedHotelId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "reservas",
            filter: `hotel_id=eq.${scopedHotelId}`,
          },
          () => void load()
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "reservas",
            filter: `hotel_id=eq.${scopedHotelId}`,
          },
          () => void load()
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

  return count;
}
