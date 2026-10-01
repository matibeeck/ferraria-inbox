"use client";

import { useEffect, useState } from "react";
import type { CapabilityMap } from "@/lib/permissions";
import { createInFlightSharer } from "@/lib/shared-in-flight";

/**
 * En la bandeja montan juntos el sidebar y la pantalla, y los dos piden sus
 * capacidades: sin esto eran dos `/api/me` idénticos en el mismo instante. Se
 * comparte solo la petición en vuelo; cada montaje posterior vuelve a preguntar.
 */
const shareInFlight = createInFlightSharer();

async function fetchCapabilities(): Promise<CapabilityMap | null> {
  const res = await fetch("/api/me", { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as { capabilities?: CapabilityMap };
  return json.capabilities ?? null;
}

/**
 * Capacidades del usuario, leídas de `/api/me`.
 *
 * Devuelve `null` mientras carga o si la petición falla. Los consumidores tratan
 * ese `null` como "todavía no sé" y pintan lo de siempre: si mostráramos menos
 * durante la carga, las pestañas parpadearían en cada navegación para las
 * recepcionistas, que son el 99% de las sesiones.
 *
 * Que el estado de carga sea permisivo no abre nada: esto decide qué pestañas se
 * dibujan, no a qué datos se llega. Todo endpoint tiene su propio gate y la RLS
 * está detrás.
 */
export function useCapabilities(): CapabilityMap | null {
  const [capabilities, setCapabilities] = useState<CapabilityMap | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const next = await shareInFlight("me", fetchCapabilities);
        if (!cancelled && next) {
          setCapabilities(next);
        }
      } catch {
        // Silencioso: el fallback es "pintar lo de siempre".
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
