/**
 * Decisiones de acceso por capacidad, sin red ni Next.
 *
 * Módulo puro a propósito: es lo que decide si un usuario pasa o recibe 403 (en
 * los Route Handlers) o redirect (en las páginas), y tiene que poder testearse
 * con `node --test`, que no resuelve el alias `@/`. Por eso los imports son
 * relativos y con extensión.
 */
import { landingPathFor } from "../routes.ts";
import type { Capability, CapabilityMap } from "../permissions.ts";

/**
 * Capacidades que dan acceso a datos de huéspedes. Los endpoints que las exigen
 * trabajan sobre `guestDataHotelIds`, NO sobre `allowedHotelIds`.
 *
 * La diferencia solo se nota con roles mezclados entre hoteles (operativo en uno,
 * recepcionista en otro). Es un caso que hoy el dashboard no puede crear, pero
 * como los handlers corren con service_role y se saltan la RLS, si apareciera
 * sería una fuga silenciosa entre hoteles del mismo usuario.
 */
export const CAPACIDADES_DE_HUESPED: ReadonlySet<Capability> = new Set<Capability>([
  "verConversacionesHuespedes",
  "enviarMensajes",
  "verReservas",
]);

/** Lo mínimo del `TenantContext` que hace falta para decidir. */
export type GateTenant = {
  capabilities: CapabilityMap;
  allowedHotelIds: readonly string[];
  guestDataHotelIds: readonly string[];
};

export type CapabilityDecision =
  | { allowed: false; hotelIds: [] }
  | { allowed: true; hotelIds: string[] };

/**
 * ¿Pasa el gate? Y si pasa, sobre qué hoteles puede operar.
 *
 * Sin la capacidad → `allowed: false` (el handler responde 403). Con ella, las
 * capacidades de huésped recortan a `guestDataHotelIds` y el resto (Solicitudes)
 * usa `allowedHotelIds`.
 */
export function decideCapability(tenant: GateTenant, capability: Capability): CapabilityDecision {
  if (!tenant.capabilities[capability]) return { allowed: false, hotelIds: [] };
  const hotelIds = CAPACIDADES_DE_HUESPED.has(capability)
    ? tenant.guestDataHotelIds
    : tenant.allowedHotelIds;
  return { allowed: true, hotelIds: [...hotelIds] };
}

/**
 * Para las páginas: `null` si el usuario puede ver la pantalla, o la ruta a la
 * que hay que mandarlo si no.
 *
 * Nunca devuelve la misma pantalla que se está protegiendo cuando el usuario no
 * tiene la capacidad: sin `verConversacionesHuespedes` el destino es
 * Solicitudes, que no lleva este chequeo, así que no hay bucle de redirects.
 */
export function pageRedirectFor(capabilities: CapabilityMap, capability: Capability): string | null {
  if (capabilities[capability]) return null;
  return landingPathFor(capabilities);
}
