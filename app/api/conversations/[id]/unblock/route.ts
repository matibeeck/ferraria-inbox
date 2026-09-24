import { NextResponse } from "next/server";
import {
  CONVERSATIONS_TABLE,
  CONVERSATION_SELECT_COLUMNS,
  type ConversationDbRow,
} from "@/lib/conversation-schema";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const isDev = process.env.NODE_ENV !== "production";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const conversationId = (await context.params).id?.trim();
    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
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

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .update({
        blocked: false,
        blocked_at: null,
        updated_at: now,
      })
      .eq("id", conversationId)
      .eq("hotel_id", activeHotelId)
      // Las columnas de bandeja, no `*`: el cliente aplica esta fila con
      // `applyConversationRowPatch`, que no lee nada más.
      .select(CONVERSATION_SELECT_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error("[conversations unblock POST]", error.code ?? "sin_code");
      return NextResponse.json(
        { error: isDev ? error.message : "No se pudo actualizar la conversación" },
        { status: 502 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, conversation: data as unknown as ConversationDbRow });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[conversations unblock POST]", isDev ? e : "error inesperado");
    return NextResponse.json({ error: isDev ? msg : "Error desconocido" }, { status: 500 });
  }
}
