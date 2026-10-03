import { NextResponse } from "next/server";
import { apiError, errorCodeForLog, isDev } from "@/lib/api-error";
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
const QUOTE_REQUESTS_EMBED = `
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
  ${QUOTE_REQUESTS_EMBED}
`;

/**
 * Archivadas piden `*` y no la lista explícita: `replaced_by` la crea la
 * migración del engine (docs/sql/reservas-01-reemplazada.sql) y este Inbox
 * sale a producción ANTES. Pedirla por nombre sin que exista hace que
 * PostgREST rechace la consulta entera; con `*` llega cuando existe y antes
 * simplemente no viene. Solo esta pestaña la necesita.
 */
const RESERVA_ARCHIVADA_SELECT = `*, ${QUOTE_REQUESTS_EMBED}`;

const ESTADOS_PROCESADOS = ["completada", "rechazada"];
const ESTADOS_ARCHIVADOS = ["reemplazada", "cancelada"];

const RESERVA_YA_NO_PENDIENTE =
  "Esta reserva ya no está pendiente: cambió de estado mientras la tenías abierta. Revisa la lista actualizada.";
const RESERVA_DUPLICADA_EN_COTIZACION =
  "No se puede volver a pendientes: ya hay otra reserva activa para esta misma cotización.";

type ReservasListTab = "pendientes" | "procesadas" | "archivadas";

function parseTab(value: string | null): ReservasListTab {
  if (value === "procesadas" || value === "archivadas") return value;
  return "pendientes";
}

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

/**
 * Le cuelga a cada reemplazada la reserva que la reemplazó, para el enlace del
 * detalle. La búsqueda va filtrada por el hotel activo: si `replaced_by` apunta
 * a una reserva que no existe o que es de otro hotel, no aparece y la
 * reemplazada queda con `reemplazo: null` ("Reemplazada", sin enlace).
 *
 * Si esta consulta falla, la pestaña se carga igual sin enlaces: el enlace es
 * una ayuda, no puede tumbar la lista.
 */
async function adjuntarReemplazos(reservas: Reserva[], activeHotelId: string): Promise<Reserva[]> {
  const ids = Array.from(
    new Set(
      reservas
        .map((reserva) => (reserva.status === "reemplazada" ? reserva.replaced_by : null))
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    )
  );
  if (ids.length === 0) {
    return reservas.map((reserva) => ({ ...reserva, reemplazo: null }));
  }

  const { data, error } = await getSupabaseServerClient()
    .from(RESERVAS_TABLE)
    .select(RESERVA_SELECT)
    .eq("hotel_id", activeHotelId)
    .in("id", ids);

  if (error) {
    console.error("[reservas GET archivadas] reemplazos", isDev ? error : errorCodeForLog(error));
    return reservas.map((reserva) => ({ ...reserva, reemplazo: null }));
  }

  const porId = new Map<string, Reserva>();
  for (const fila of (data ?? []) as unknown as Reserva[]) {
    if (fila.hotel_id === activeHotelId) porId.set(fila.id, fila);
  }
  return reservas.map((reserva) => ({
    ...reserva,
    reemplazo:
      reserva.status === "reemplazada" && reserva.replaced_by
        ? porId.get(reserva.replaced_by) ?? null
        : null,
  }));
}

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);
    const countOnly = url.searchParams.get("count") === "1";
    const tab = parseTab(url.searchParams.get("tab"));
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

    if (tab === "archivadas") {
      const { data, error } = await getSupabaseServerClient()
        .from(RESERVAS_TABLE)
        .select(RESERVA_ARCHIVADA_SELECT)
        .eq("hotel_id", activeHotelId)
        .in("status", ESTADOS_ARCHIVADOS)
        // No tienen fecha de procesado: el orden es por cuándo nacieron.
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        return apiError(502, "reservas_query_failed", {
          cause: error,
          log: "[reservas GET archivadas]",
          message: "No se pudieron cargar las reservas archivadas",
        });
      }

      const archivadas = (data ?? []) as unknown as Reserva[];
      return NextResponse.json({
        reservas: await adjuntarReemplazos(archivadas, activeHotelId),
        availableHotels,
        activeHotelId,
      });
    }

    const query =
      tab === "procesadas"
        ? baseReservasQuery(activeHotelId)
            .in("status", ESTADOS_PROCESADOS)
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
      .select("id, hotel_id, status")
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

    // Completar y rechazar son solo para pendientes. La pantalla ya no los
    // muestra en otro estado, pero el detalle abierto puede estar viejo: si el
    // engine reemplazó la reserva mientras recepción la miraba, completarla
    // revive una reserva con fechas que el huésped ya cambió.
    const estadoActual = typeof reservaRow.status === "string" ? reservaRow.status : "";
    const soloDesdePendiente = body.action === "complete" || body.action === "reject";
    if (soloDesdePendiente && estadoActual !== "pendiente") {
      return NextResponse.json({ error: RESERVA_YA_NO_PENDIENTE }, { status: 409 });
    }

    // Revivir una reemplazada la deja sin la referencia a la nueva: una
    // pendiente que dice "reemplazada por…" se contradice sola. Solo se escribe
    // si la fila es reemplazada, que es justo cuando la columna existe seguro.
    if (body.action === "reopen" && estadoActual === "reemplazada") {
      patch.replaced_by = null;
    }

    let update = supabase
      .from(RESERVAS_TABLE)
      .update(patch)
      .eq("id", id)
      .eq("hotel_id", hotelId);
    // Mismo candado en la escritura, por si el estado cambió entre la lectura
    // de arriba y esta línea.
    if (soloDesdePendiente) update = update.eq("status", "pendiente");

    const { data, error } = await update.select(RESERVA_SELECT).maybeSingle();

    if (error && error.code === "23505") {
      // Índice único de una reserva viva por cotización: ya hay otra activa
      // para la misma cotización, así que esta no se puede revivir.
      return NextResponse.json({ error: RESERVA_DUPLICADA_EN_COTIZACION }, { status: 409 });
    }
    if (error) {
      return apiError(502, "reserva_update_failed", {
        cause: error,
        log: "[reservas PATCH]",
        message: "No se pudo actualizar la reserva",
      });
    }
    if (!data) {
      if (soloDesdePendiente) {
        return NextResponse.json({ error: RESERVA_YA_NO_PENDIENTE }, { status: 409 });
      }
      return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, reserva: data as unknown as Reserva });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[reservas PATCH]", message: "No se pudo actualizar la reserva" });
  }
}
