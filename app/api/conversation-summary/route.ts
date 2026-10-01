import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/** Detalle crudo de Supabase y de excepciones solo en desarrollo. */
const isDev = process.env.NODE_ENV !== "production";

/**
 * Lee `conversation_summaries` con el cliente de servidor (service role, se
 * salta la RLS). Requiere sesión en el inbox y que la conversación sea de un
 * hotel permitido.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversation_id")?.trim();
    if (!conversationId) {
      return NextResponse.json({ error: "conversation_id es obligatorio" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // Ownership: la conversación debe ser de un hotel permitido.
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    const ownership = await assertConversationInHotel(supabase, conversationId, allowedHotelIds);
    if (ownership.response) return ownership.response;

    // Doble candado: además de la conversación ya validada, el resumen tiene
    // que ser del MISMO hotel. Filtro en el query, sin apoyarse en RLS.
    const { data, error: supabaseError } = await supabase
      .from("conversation_summaries")
      .select("summary")
      .eq("conversation_id", conversationId)
      .eq("hotel_id", ownership.hotelId)
      .maybeSingle();

    if (supabaseError) {
      console.error(
        "[conversation-summary GET] select",
        supabaseError.code ?? "sin_code",
        isDev ? supabaseError.message : ""
      );
      return NextResponse.json({ error: "No se pudo cargar el resumen" }, { status: 502 });
    }

    return NextResponse.json({ data });
  } catch (e) {
    console.error(
      "[conversation-summary GET] error inesperado",
      isDev ? e : e instanceof Error ? e.name : "unknown"
    );
    return NextResponse.json(
      { error: isDev && e instanceof Error ? e.message : "No se pudo cargar el resumen" },
      { status: 500 }
    );
  }
}
