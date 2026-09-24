import { cache } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  capabilitiesForRoles,
  isHotelRole,
  type CapabilityMap,
} from "./permissions.ts";
import { memoPerRequest } from "./request-memo.ts";

const HOTEL_USERS_TABLE = "hotel_users";
const HOTELS_TABLE = "hotels";

export type AvailableHotel = {
  id: string;
  name: string;
};

/**
 * Una fila de `hotels` con todo lo que los endpoints del inbox necesitan saber
 * del hotel: si aparece en el selector (`isActive`, `name`), cuál es su número
 * de WhatsApp (para clasificar qué mensajes son de la IA) y sus flags.
 */
export type HotelRecord = {
  id: string;
  name: string;
  isActive: boolean;
  whatsappNumber: string | null;
  engineEnabled: boolean;
  templatesEnabled: boolean;
};

/** Una fila de `hotel_users`: a qué hotel pertenece el usuario, con qué rol y área. */
export type HotelMembership = {
  hotelId: string;
  /** Literal crudo de la base. Puede ser `null` o un valor no reconocido. */
  role: string | null;
  /** Solo la tienen los `operativo`. Mismo vocabulario que `service_tickets.categoria`. */
  area: string | null;
};

/**
 * Contexto de tenencia de una petición. Se resuelve UNA vez por request y trae
 * todo lo que necesitan el gate de capacidad y el filtro por hotel.
 *
 * `allowedHotelIds` vs `guestDataHotelIds` es la distinción que importa: el
 * primero es "hoteles donde el usuario existe", el segundo es "hoteles donde
 * además puede ver datos de huéspedes". Para todo el mundo menos los operativos
 * son la misma lista.
 */
export type TenantContext = {
  memberships: HotelMembership[];
  capabilities: CapabilityMap;
  allowedHotelIds: string[];
  guestDataHotelIds: string[];
  /**
   * Filas de `hotels` de los hoteles en `allowedHotelIds` (activos o no),
   * ordenadas por nombre como las devuelve la base. Nunca trae hoteles fuera de
   * `allowedHotelIds`: el recorte se hace al armar el contexto.
   */
  hotels: HotelRecord[];
};

function normalizeRole(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value : null;
}

const HOTEL_DIRECTORY_COLUMNS =
  "id, name, is_active, whatsapp_number, engine_enabled, templates_enabled";

async function loadHotelDirectory(supabase: SupabaseClient): Promise<HotelRecord[]> {
  const { data, error } = await supabase
    .from(HOTELS_TABLE)
    .select(HOTEL_DIRECTORY_COLUMNS)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .map((row) => ({
      id: row.id != null ? String(row.id).trim() : "",
      name: String(row.name ?? row.id),
      isActive: row.is_active === true,
      whatsappNumber: row.whatsapp_number != null ? String(row.whatsapp_number) : null,
      engineEnabled: row.engine_enabled === true,
      templatesEnabled: row.templates_enabled === true,
    }))
    .filter((row) => row.id);
}

/**
 * TODAS las filas de `hotels`, una sola lectura por request.
 *
 * Se trae la tabla entera (son pocos hoteles, muy lejos del tope de 1000 de
 * PostgREST) para que la lectura NO dependa de `hotel_users` y pueda ir en
 * paralelo con ella. Esto corre con service role: el directorio completo nunca
 * sale de este módulo sin pasar por el recorte de `allowedHotelIds`.
 *
 * Una sola lectura cubre lo que antes eran hasta tres: la lista de ids para
 * `super_admin`, el selector de hoteles activos y el `whatsapp_number` + flags.
 */
const getHotelDirectory = cache(
  (supabase: SupabaseClient): Promise<HotelRecord[]> =>
    memoPerRequest("hotel-directory", () => loadHotelDirectory(supabase))
);

/** Filas crudas de `hotel_users` para el usuario. */
export async function resolveUserMemberships(
  supabase: SupabaseClient,
  user: User
): Promise<HotelMembership[]> {
  const { data, error } = await supabase
    .from(HOTEL_USERS_TABLE)
    .select("hotel_id, role, area")
    .eq("user_id", user.id);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .map((row) => ({
      hotelId: row.hotel_id != null ? String(row.hotel_id).trim() : "",
      role: normalizeRole(row.role),
      area: normalizeRole(row.area),
    }))
    .filter((row) => row.hotelId);
}

function hasSuperAdmin(memberships: readonly HotelMembership[]): boolean {
  return memberships.some((m) => m.role === "super_admin");
}

/**
 * Resuelve capacidades y las DOS listas de hoteles en una sola pasada.
 *
 * `guestDataHotelIds` espeja la función `user_guest_data_hotel_ids()` de la RLS:
 * excluye las membresías con rol `operativo`. Ese espejo no es redundante —
 * los route handlers corren con service_role y se saltan la RLS, así que sin
 * esta lista el recorte solo existiría en el navegador.
 *
 * Un rol NO reconocido (typo, `null`) no aporta hoteles a `guestDataHotelIds`:
 * lista blanca estricta, igual que la matriz de capacidades.
 */
export const resolveTenantContext = cache(
  (supabase: SupabaseClient, user: User): Promise<TenantContext> =>
    memoPerRequest(`tenant:${user.id}`, () => loadTenantContext(supabase, user))
);

/** Hoteles del directorio que están en `ids`, conservando el orden por nombre. */
function pickHotels(directory: readonly HotelRecord[], ids: readonly string[]): HotelRecord[] {
  const wanted = new Set(ids);
  return directory.filter((hotel) => wanted.has(hotel.id));
}

/**
 * `hotel_users` y `hotels` son independientes: van en paralelo, un solo viaje
 * de ida y vuelta en vez de dos o tres en serie.
 */
async function loadTenantContext(supabase: SupabaseClient, user: User): Promise<TenantContext> {
  const [memberships, directory] = await Promise.all([
    resolveUserMemberships(supabase, user),
    getHotelDirectory(supabase),
  ]);
  const capabilities = capabilitiesForRoles(memberships.map((m) => m.role));

  if (hasSuperAdmin(memberships)) {
    const every = directory.map((hotel) => hotel.id);
    return {
      memberships,
      capabilities,
      allowedHotelIds: every,
      guestDataHotelIds: every,
      hotels: [...directory],
    };
  }

  const allowed = new Set<string>();
  const guestData = new Set<string>();

  for (const membership of memberships) {
    allowed.add(membership.hotelId);
    // Un rol desconocido no suma: si no está en la matriz, no ve huéspedes.
    if (isHotelRole(membership.role) && membership.role !== "operativo") {
      guestData.add(membership.hotelId);
    }
  }

  const allowedHotelIds = [...allowed];
  const guestDataHotelIds = [...guestData];

  warnOnMixedRoles(user, memberships, allowedHotelIds, guestDataHotelIds);

  return {
    memberships,
    capabilities,
    allowedHotelIds,
    guestDataHotelIds,
    hotels: pickHotels(directory, allowedHotelIds),
  };
}

/**
 * Avisa cuando un usuario tiene roles mezclados entre hoteles (p. ej. operativo
 * en uno y recepcionista en otro).
 *
 * Hoy el dashboard asigna el MISMO rol a todas las membresías de un usuario
 * (`POST /api/team/users`), así que esta situación solo puede nacer de una
 * edición manual de `hotel_users`. Es una misconfiguración que queremos ver, no
 * absorber en silencio: el recorte se aplica igual, pero sin el log un usuario
 * quedaría a medias sin que nadie se entere.
 *
 * Loguea `user_id` y los `hotel_id` recortados. Es metadata de configuración de
 * personal, no contenido de huéspedes, así que no cae bajo la regla de no
 * loguear datos. El recorte NUNCA depende de que este log salga.
 */
function warnOnMixedRoles(
  user: User,
  memberships: readonly HotelMembership[],
  allowedHotelIds: readonly string[],
  guestDataHotelIds: readonly string[]
): void {
  const sinDatosDeHuesped = allowedHotelIds.filter((id) => !guestDataHotelIds.includes(id));
  // Solo es "mezcla" si convive con al menos una membresía que SÍ ve huéspedes.
  if (sinDatosDeHuesped.length === 0 || guestDataHotelIds.length === 0) return;

  console.warn(
    "[inbox-tenant] roles mezclados entre hoteles: se recortan los hoteles sin acceso a datos de huéspedes",
    {
      user_id: user.id,
      hotel_ids_recortados: sinDatosDeHuesped,
      roles: memberships.map((m) => ({ hotel_id: m.hotelId, role: m.role })),
    }
  );
}

/**
 * Hoteles donde el usuario existe, sin mirar el rol.
 *
 * OJO: para endpoints que sirven datos de huéspedes esta NO es la lista
 * correcta — usá `guestDataHotelIds` de `resolveTenantContext`. Esta sigue
 * siendo la buena para lo que es transversal al usuario (selector de hotel,
 * suscripciones push, Solicitudes).
 */
export async function resolveAllowedHotelIds(
  supabase: SupabaseClient,
  user: User
): Promise<string[]> {
  const { allowedHotelIds } = await resolveTenantContext(supabase, user);
  return allowedHotelIds;
}

/**
 * Hoteles del selector: activos, dentro de `allowedHotelIds`, por nombre.
 *
 * Sin viaje propio: sale del directorio de `hotels` que ya se leyó en esta
 * request (lo lee `resolveTenantContext`). Si se llama sin contexto previo, lo
 * lee una vez y queda para el resto de la request.
 */
export async function resolveAvailableHotels(
  supabase: SupabaseClient,
  allowedHotelIds: string[]
): Promise<AvailableHotel[]> {
  if (allowedHotelIds.length === 0) return [];
  const directory = await getHotelDirectory(supabase);
  return availableHotelsFrom(directory, allowedHotelIds);
}

/** Versión pura de `resolveAvailableHotels` sobre filas ya leídas. */
export function availableHotelsFrom(
  hotels: readonly HotelRecord[],
  allowedHotelIds: readonly string[]
): AvailableHotel[] {
  return pickHotels(hotels, allowedHotelIds)
    .filter((hotel) => hotel.isActive)
    .map((hotel) => ({ id: hotel.id, name: hotel.name }));
}

export function resolveActiveHotelId(
  requestedHotelId: string,
  allowedHotelIds: string[],
  availableHotels: AvailableHotel[]
): { activeHotelId: string | null; forbidden: boolean } {
  if (requestedHotelId) {
    if (!allowedHotelIds.includes(requestedHotelId)) {
      return { activeHotelId: null, forbidden: true };
    }
    return { activeHotelId: requestedHotelId, forbidden: false };
  }

  if (availableHotels.length === 0) {
    return { activeHotelId: null, forbidden: false };
  }

  return { activeHotelId: availableHotels[0]!.id, forbidden: false };
}
