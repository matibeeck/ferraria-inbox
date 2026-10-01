import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { fetchHotelMessageTemplates } from "@/lib/message-templates";

export const dynamic = "force-dynamic";

/** Plantillas de WhatsApp activas del hotel activo (scoped al tenant del usuario). */
export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const requestedHotelId = new URL(request.url).searchParams.get("hotelId")?.trim() ?? "";

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "enviarMensajes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    const availableHotels = await resolveAvailableHotels(supabase, allowedHotelIds);
    const { activeHotelId, forbidden } = resolveActiveHotelId(
      requestedHotelId,
      allowedHotelIds,
      availableHotels
    );

    if (forbidden) {
      return NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 });
    }
    if (!activeHotelId) {
      return NextResponse.json({ templates: [], activeHotelId: null });
    }

    const templates = await fetchHotelMessageTemplates(supabase, activeHotelId);
    return NextResponse.json({ templates, activeHotelId });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[message-templates GET]", message: "No se pudieron cargar las plantillas" });
  }
}
