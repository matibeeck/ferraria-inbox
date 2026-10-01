import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";

export const dynamic = "force-dynamic";

type CancelBody = {
  conversationId?: unknown;
  quoteRequestId?: unknown;
  stage?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    let body: CancelBody;
    try {
      body = (await request.json()) as CancelBody;
    } catch {
      return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
    }

    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const quoteRequestId =
      typeof body.quoteRequestId === "string" ? body.quoteRequestId.trim() : "";
    const stage = typeof body.stage === "string" ? body.stage.trim() : "";

    if (!conversationId || !quoteRequestId || !stage) {
      return NextResponse.json(
        { error: "conversationId, quoteRequestId y stage son obligatorios" },
        { status: 400 }
      );
    }

    const requestedHotelId = new URL(request.url).searchParams.get("hotelId")?.trim() ?? "";

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
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
      return NextResponse.json({ error: "hotelId es obligatorio" }, { status: 400 });
    }

    // La conversación tiene que ser de un hotel del usuario, y su `hotel_id` es
    // el que manda. Si el cliente pidió otro hotel, no se mezcla: 403.
    const ownership = await assertConversationInHotel(supabase, conversationId, allowedHotelIds);
    if (ownership.response) return ownership.response;
    const hotelId = ownership.hotelId;
    if (requestedHotelId && requestedHotelId !== hotelId) {
      return NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 });
    }

    // La cotización tiene que ser del MISMO hotel que la conversación. Es la
    // misma condición con la que `get_pending_followups`/`get_followup_candidates`
    // arman el seguimiento (`c.hotel_id = q.hotel_id`), así que un seguimiento
    // real siempre la cumple. Filtro en el query, sin apoyarse en RLS.
    const { data: quote, error: quoteError } = await supabase
      .from("quote_requests")
      .select("id")
      .eq("id", quoteRequestId)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (quoteError) {
      return apiError(502, "quote_lookup_failed", {
        cause: quoteError,
        log: "[followups cancel POST] quote lookup",
        message: "No se pudo cancelar el seguimiento",
      });
    }
    if (!quote) {
      return NextResponse.json({ error: "Cotización no encontrada" }, { status: 404 });
    }

    const { error } = await supabase.from("followup_log").insert({
      hotel_id: hotelId,
      conversation_id: conversationId,
      quote_request_id: quoteRequestId,
      stage,
    });

    if (error) {
      // Índice único en (quote_request_id, stage): si ya existe, el seguimiento ya
      // fue atendido — no es un error real.
      if (error.code === "23505") {
        return NextResponse.json({ ok: true, alreadyExists: true });
      }
      return apiError(502, "followup_insert_failed", {
        cause: error,
        log: "[followups cancel POST]",
        message: "No se pudo cancelar el seguimiento",
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[followups cancel POST]", message: "No se pudo cancelar el seguimiento" });
  }
}
