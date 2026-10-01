import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
  type AvailableHotel,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { Reserva } from "@/app/reservas/lib/types";

export const dynamic = "force-dynamic";

const RESERVAS_TABLE = "reservas";
const RESERVA_SELECT = `
  id,
  hotel_id,
  quote_request_id,
  conversation_id,
  titular_nombre,
  cedula,
  correo,
  notas,
  status,
  rejection_reason,
  created_at,
  completed_at,
  processed_by,
  quote_requests (
    id,
    sender_phone,
    guest_name,
    guest_email,
    fecha_entrada,
    fecha_salida,
    nights,
    num_rooms,
    room_type_requested,
    adults,
    children,
    pets,
    breakfast_included,
    total_amount,
    breakdown_json,
    conversation_id
  )
`;

type ReservasTenantContext =
  | { kind: "forbidden" }
  | { kind: "empty"; availableHotels: AvailableHotel[]; activeHotelId: null }
  | {
      kind: "ok";
      supabase: SupabaseClient;
      activeHotelId: string;
      availableHotels: AvailableHotel[];
    };

async function resolveReservasTenant(request: Request, user: User): Promise<ReservasTenantContext> {
  const supabase = getSupabaseServerClient();

  // Reservas trabaja sobre conversaciones y cotizaciones de huéspedes: un
  // `operativo` no entra acá. `forbidden` ya existe y el GET lo traduce a 403.
  const gate = await requireCapability(supabase, user, "verReservas");
  if (gate.response) {
    return { kind: "forbidden" };
  }
  const allowedHotelIds = gate.allowedHotelIds;

  const requestedHotelId = new URL(request.url).searchParams.get("hotelId")?.trim() ?? "";
  const availableHotels = await resolveAvailableHotels(supabase, allowedHotelIds);
  const { activeHotelId, forbidden } = resolveActiveHotelId(
    requestedHotelId,
    allowedHotelIds,
    availableHotels
  );

  if (forbidden) {
    return { kind: "forbidden" };
  }
  if (!activeHotelId) {
    return { kind: "empty", availableHotels, activeHotelId: null };
  }
  return { kind: "ok", supabase, activeHotelId, availableHotels };
}

function baseReservasQuery(activeHotelId: string) {
  return getSupabaseServerClient()
    .from(RESERVAS_TABLE)
    .select(RESERVA_SELECT)
    .eq("hotel_id", activeHotelId);
}

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);
    const countOnly = url.searchParams.get("count") === "1";
    const tab = url.searchParams.get("tab") === "procesadas" ? "procesadas" : "pendientes";
    const tenant = await resolveReservasTenant(request, auth.user);

    if (tenant.kind === "forbidden") {
      return NextResponse.json({ error: "No autorizado para ver este hotel" }, { status: 403 });
    }

    if (tenant.kind === "empty") {
      return NextResponse.json({
        reservas: [],
        count: 0,
        availableHotels: tenant.availableHotels,
        activeHotelId: tenant.activeHotelId,
      });
    }

    const { activeHotelId, availableHotels } = tenant;

    if (countOnly) {
      const { count, error } = await getSupabaseServerClient()
        .from(RESERVAS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", activeHotelId)
        .eq("status", "pendiente");

      if (error) {
        return apiError(502, "reservas_count_failed", {
          cause: error,
          log: "[reservas count GET]",
          message: "No se pudieron contar las reservas",
        });
      }
      return NextResponse.json({
        count: count ?? 0,
        availableHotels,
        activeHotelId,
      });
    }

    const query =
      tab === "procesadas"
        ? baseReservasQuery(activeHotelId)
            .in("status", ["completada", "rechazada"])
            .order("completed_at", { ascending: false, nullsFirst: false })
            .order("created_at", { ascending: false })
            .limit(100)
        : baseReservasQuery(activeHotelId)
            .eq("status", "pendiente")
            .order("created_at", { ascending: false });

    const { data, error } = await query;
    if (error) {
      return apiError(502, "reservas_query_failed", {
        cause: error,
        log: "[reservas GET]",
        message: "No se pudieron cargar las reservas",
      });
    }

    return NextResponse.json({
      reservas: (data ?? []) as unknown as Reserva[],
      availableHotels,
      activeHotelId,
    });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[reservas GET]", message: "No se pudieron cargar las reservas" });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as {
      id?: string;
      action?: "complete" | "reject" | "reopen";
      rejectionReason?: string;
    };

    const id = body.id?.trim();
    if (!id) {
      return NextResponse.json({ error: "id es obligatorio" }, { status: 400 });
    }

    const now = new Date().toISOString();
    let patch: Record<string, unknown>;

    if (body.action === "complete") {
      patch = {
        status: "completada",
        completed_at: now,
      };
    } else if (body.action === "reject") {
      const reason = body.rejectionReason?.trim();
      if (!reason) {
        return NextResponse.json({ error: "rejectionReason es obligatorio" }, { status: 400 });
      }
      patch = {
        status: "rechazada",
        rejection_reason: reason,
        completed_at: now,
      };
    } else if (body.action === "reopen") {
      patch = {
        status: "pendiente",
        completed_at: null,
        rejection_reason: null,
      };
    } else {
      return NextResponse.json({ error: "action debe ser complete, reject o reopen" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verReservas");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;

    const { data: reservaRow, error: fetchError } = await supabase
      .from(RESERVAS_TABLE)
      .select("id, hotel_id")
      .eq("id", id)
      .maybeSingle();

    if (fetchError) {
      return apiError(502, "reserva_lookup_failed", {
        cause: fetchError,
        log: "[reservas PATCH] fetch",
        message: "No se pudo actualizar la reserva",
      });
    }
    if (!reservaRow) {
      return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });
    }

    const hotelId = reservaRow.hotel_id != null ? String(reservaRow.hotel_id).trim() : "";
    if (!hotelId || !allowedHotelIds.includes(hotelId)) {
      return NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from(RESERVAS_TABLE)
      .update(patch)
      .eq("id", id)
      .eq("hotel_id", hotelId)
      .select(RESERVA_SELECT)
      .maybeSingle();

    if (error) {
      return apiError(502, "reserva_update_failed", {
        cause: error,
        log: "[reservas PATCH]",
        message: "No se pudo actualizar la reserva",
      });
    }
    if (!data) {
      return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, reserva: data as unknown as Reserva });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[reservas PATCH]", message: "No se pudo actualizar la reserva" });
  }
}
