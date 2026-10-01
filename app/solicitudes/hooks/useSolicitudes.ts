"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMotivoSinAviso, type AvisoCierre } from "@/lib/aviso-cierre";
import type { AvailableHotel } from "@/lib/inbox-tenant";
import {
  ordenarTickets,
  type ServiceTicket,
  type SolicitudesFiltro,
  type TicketEstado,
} from "@/lib/service-tickets";

/**
 * Cada cuánto se vuelve a preguntar por solicitudes nuevas.
 *
 * Es polling y NO Realtime a propósito: no está confirmado que
 * `service_tickets` esté en la publicación `supabase_realtime`. Si no lo está,
 * una suscripción se conecta sin error y no dispara nunca — el mantenimiento se
 * quedaría mirando una lista congelada creyendo que no hay nada pendiente. Un
 * poll que llega 30 segundos tarde es honesto; un canal mudo, no.
 *
 * Migrar a Realtime después es cambiar este hook y nada más.
 */
const POLL_MS = 30_000;

type Respuesta = {
  solicitudes?: ServiceTicket[];
  availableHotels?: AvailableHotel[];
  activeHotelId?: string | null;
  puedeVerConversaciones?: boolean;
  error?: string;
};

export type EstadoDeCarga = "cargando" | "lista" | "sin-acceso" | "error";

export function useSolicitudes({
  activeHotelId,
  filtro,
}: {
  activeHotelId: string | null;
  filtro: SolicitudesFiltro;
}) {
  const [solicitudes, setSolicitudes] = useState<ServiceTicket[]>([]);
  const [availableHotels, setAvailableHotels] = useState<AvailableHotel[]>([]);
  const [resolvedActiveHotelId, setResolvedActiveHotelId] = useState<string | null>(null);
  const [puedeVerConversaciones, setPuedeVerConversaciones] = useState(false);
  const [estado, setEstado] = useState<EstadoDeCarga>("cargando");
  const [error, setError] = useState<string | null>(null);

  // Evita que una respuesta lenta de un filtro viejo pise a una más nueva.
  const peticionRef = useRef(0);

  /**
   * `mostrarCarga` distingue la primera carga (o un cambio de filtro/hotel) de
   * un refresco del polling. Sin esa distinción, cada 30 segundos la lista se
   * reemplazaría por "Cargando solicitudes..." y parpadearía en la cara de quien
   * está trabajando.
   */
  const cargar = useCallback(async (mostrarCarga = false) => {
    const miPeticion = ++peticionRef.current;
    if (mostrarCarga) setEstado("cargando");

    const params = new URLSearchParams({ filtro });
    if (activeHotelId) params.set("hotelId", activeHotelId);

    try {
      const respuesta = await fetch(`/api/solicitudes?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await respuesta.json()) as Respuesta;
      if (miPeticion !== peticionRef.current) return;

      if (respuesta.status === 403) {
        setEstado("sin-acceso");
        setSolicitudes([]);
        return;
      }
      if (!respuesta.ok) {
        setError(payload.error ?? "No se pudo cargar las solicitudes");
        setEstado("error");
        return;
      }

      setSolicitudes(payload.solicitudes ?? []);
      setAvailableHotels(payload.availableHotels ?? []);
      setResolvedActiveHotelId(payload.activeHotelId ?? null);
      setPuedeVerConversaciones(Boolean(payload.puedeVerConversaciones));
      setError(null);
      setEstado("lista");
    } catch {
      if (miPeticion !== peticionRef.current) return;
      setError("No hay conexión con el servidor");
      setEstado("error");
    }
  }, [activeHotelId, filtro]);

  // Carga inicial + polling que se apaga con la pestaña oculta: recepción deja
  // el inbox abierto todo el turno y no tiene sentido gastarle batería a la
  // tablet en segundo plano. Al volver al foco se refresca de inmediato, sin
  // esperar el intervalo.
  useEffect(() => {
    let timer: number | null = null;

    const arrancar = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => void cargar(), POLL_MS);
    };
    const parar = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const alCambiarVisibilidad = () => {
      if (document.visibilityState === "visible") {
        void cargar();
        arrancar();
      } else {
        parar();
      }
    };

    void (async () => {
      await cargar(true);
    })();

    if (document.visibilityState === "visible") arrancar();
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    return () => {
      parar();
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
    };
  }, [cargar]);

  /**
   * Devuelve el resultado del aviso al huésped cuando el servidor lo intentó
   * (solo al resolver), o `null` si no aplica — por ejemplo, la segunda tablet
   * que toca "Resolver" sobre una solicitud que ya estaba resuelta.
   */
  const cambiarEstado = useCallback(
    async (id: string, nuevoEstado: TicketEstado): Promise<AvisoCierre | null> => {
      const respuesta = await fetch("/api/solicitudes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, estado: nuevoEstado }),
      });
      const payload = (await respuesta.json()) as {
        solicitud?: ServiceTicket;
        error?: string;
        aviso?: { enviado?: unknown; motivo?: unknown };
      };

      if (!respuesta.ok) {
        // El 409 significa que alguien más la movió: se recarga para que la
        // pantalla muestre la verdad en vez de insistir con lo que ya no es.
        if (respuesta.status === 409) void cargar();
        throw new Error(payload.error ?? "No se pudo actualizar la solicitud");
      }

      const actualizada = payload.solicitud;
      if (actualizada) {
        setSolicitudes((previas) =>
          previas.map((t) => (t.id === actualizada.id ? actualizada : t))
        );
      }
      // Recarga en segundo plano: con el filtro "Abiertas" la solicitud resuelta
      // tiene que desaparecer de la lista, no quedarse pintada como resuelta.
      void cargar();

      const aviso = payload.aviso;
      if (!aviso || typeof aviso.enviado !== "boolean") return null;
      return aviso.enviado
        ? { enviado: true }
        : { enviado: false, ...(isMotivoSinAviso(aviso.motivo) ? { motivo: aviso.motivo } : {}) };
    },
    [cargar]
  );

  const ordenadas = useMemo(() => ordenarTickets(solicitudes), [solicitudes]);

  return {
    solicitudes: ordenadas,
    estado,
    error,
    availableHotels,
    resolvedActiveHotelId,
    puedeVerConversaciones,
    cambiarEstado,
    refrescar: cargar,
  };
}
