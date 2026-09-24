import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { CONVERSATIONS_TABLE } from "@/lib/conversation-schema";
import {
  availableHotelsFrom,
  resolveActiveHotelId,
  resolveTenantContext,
  type AvailableHotel,
  type HotelRecord,
  type TenantContext,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { requireCapability } from "@/lib/auth/require-capability";
import type { Capability } from "@/lib/permissions";
import { WUBBY_TABLE } from "@/lib/wubby-schema";

/**
 * Resuelve el hotel activo de la petición y valida que el usuario tenga acceso.
 *
 * Idioma `{ response }` igual que `requireSessionUser`: si `response !== null`,
 * devuélvela tal cual (403 forbidden). El caso "sin hotel activo" NO es un error
 * aquí: se expone como `activeHotelId: null` para que cada endpoint decida su
 * política (400 "hotelId obligatorio" vs. 200 con lista vacía).
 *
 * El `hotelId` pedido puede venir de fuentes distintas (query `?hotelId`, body,
 * formData); por eso `options.requestedHotelId` permite inyectarlo. Si se omite,
 * se lee de `?hotelId`.
 */
export type ActiveHotelResult = {
  response: NextResponse | null;
  supabase: SupabaseClient;
  allowedHotelIds: string[];
  availableHotels: AvailableHotel[];
  activeHotelId: string | null;
  /**
   * Filas de `hotels` (número de WhatsApp y flags) de `allowedHotelIds`, ya
   * leídas en esta request. Usalas en vez de volver a consultar `hotels`.
   */
  hotels: HotelRecord[];
};

export async function requireActiveHotel(
  request: Request,
  user: User,
  options?: { requestedHotelId?: string; capability?: Capability }
): Promise<ActiveHotelResult> {
  const supabase = getSupabaseServerClient();

  // Con `capability`, el gate de rol y el recorte de hoteles se resuelven en la
  // misma pasada: sin ella el comportamiento queda idéntico al de antes.
  // `hotel_users` y `hotels` se leen UNA vez por request, en paralelo, dentro
  // de `resolveTenantContext`; de acá en adelante no hay más viajes de tenencia.
  let allowedHotelIds: string[];
  let tenant: TenantContext;
  if (options?.capability) {
    const gate = await requireCapability(supabase, user, options.capability);
    if (gate.response) {
      return {
        response: gate.response,
        supabase,
        allowedHotelIds: [],
        availableHotels: [],
        activeHotelId: null,
        hotels: [],
      };
    }
    allowedHotelIds = gate.allowedHotelIds;
    tenant = gate.tenant;
  } else {
    tenant = await resolveTenantContext(supabase, user);
    allowedHotelIds = tenant.allowedHotelIds;
  }
  const allowedSet = new Set(allowedHotelIds);
  const hotels = tenant.hotels.filter((hotel) => allowedSet.has(hotel.id));

  const requestedHotelId = (
    options?.requestedHotelId ??
    new URL(request.url).searchParams.get("hotelId") ??
    ""
  ).trim();

  const availableHotels = availableHotelsFrom(hotels, allowedHotelIds);
  const { activeHotelId, forbidden } = resolveActiveHotelId(
    requestedHotelId,
    allowedHotelIds,
    availableHotels
  );

  if (forbidden) {
    return {
      response: NextResponse.json(
        { error: "No autorizado para ver este hotel" },
        { status: 403 }
      ),
      supabase,
      allowedHotelIds,
      availableHotels,
      activeHotelId: null,
      hotels,
    };
  }

  return { response: null, supabase, allowedHotelIds, availableHotels, activeHotelId, hotels };
}

/**
 * Confirma que una fila (`id`) pertenece a un hotel permitido, derivando el
 * `hotel_id` de la propia fila. Útil cuando conocemos el `id` pero el cliente no
 * envía `hotelId`. Devuelve el `hotelId` real para usarlo como doble candado en
 * el `update().eq("hotel_id", hotelId)` posterior.
 */
export type HotelOwnershipResult =
  | { response: NextResponse; hotelId: null }
  | { response: null; hotelId: string };

export async function assertRowInAllowedHotel(
  supabase: SupabaseClient,
  table: string,
  id: string,
  allowedHotelIds: string[]
): Promise<HotelOwnershipResult> {
  const { data, error } = await supabase
    .from(table)
    .select("id, hotel_id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return {
      response: NextResponse.json({ error: error.message }, { status: 502 }),
      hotelId: null,
    };
  }
  if (!data) {
    return {
      response: NextResponse.json({ error: "Recurso no encontrado" }, { status: 404 }),
      hotelId: null,
    };
  }

  const hotelId = data.hotel_id != null ? String(data.hotel_id).trim() : "";
  if (!hotelId || !allowedHotelIds.includes(hotelId)) {
    return {
      response: NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 }),
      hotelId: null,
    };
  }

  return { response: null, hotelId };
}

/** Alias conveniente de `assertRowInAllowedHotel` para la tabla `conversations`. */
export function assertConversationInHotel(
  supabase: SupabaseClient,
  id: string,
  allowedHotelIds: string[]
): Promise<HotelOwnershipResult> {
  return assertRowInAllowedHotel(supabase, CONVERSATIONS_TABLE, id, allowedHotelIds);
}

/**
 * Confirma que un objeto de storage (por su `media_storage_path`) pertenece a un
 * hotel permitido. El path SIEMPRE proviene de una fila de `Wubby_Whatsapp`, así
 * que validamos esa fila — funciona igual para media entrante (n8n) y saliente
 * (esta app), sin depender del formato del nombre del objeto.
 */
export async function assertStoragePathInHotel(
  supabase: SupabaseClient,
  storagePath: string,
  allowedHotelIds: string[]
): Promise<HotelOwnershipResult> {
  // Lookups .eq parametrizados (sin inyección PostgREST: el path es del cliente).
  let row: { hotel_id?: string | null } | null = null;
  for (const column of ["media_storage_path", "storage_path"] as const) {
    const { data, error } = await supabase
      .from(WUBBY_TABLE)
      .select("hotel_id")
      .eq(column, storagePath)
      .limit(1)
      .maybeSingle();
    // `storage_path` puede no existir como columna: ese error es best-effort.
    if (error && column === "media_storage_path") {
      return { response: NextResponse.json({ error: error.message }, { status: 502 }), hotelId: null };
    }
    if (data) {
      row = data;
      break;
    }
  }

  if (!row) {
    return { response: NextResponse.json({ error: "Recurso no encontrado" }, { status: 404 }), hotelId: null };
  }
  const hotelId = row.hotel_id != null ? String(row.hotel_id).trim() : "";
  if (!hotelId || !allowedHotelIds.includes(hotelId)) {
    return { response: NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 }), hotelId: null };
  }
  return { response: null, hotelId };
}
