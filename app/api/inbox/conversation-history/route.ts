/**
 * Bloque "Historial" de la ficha: los últimos tramos etiquetados de UNA
 * conversación (`conversation_labels`), ya en español.
 *
 * Aislamiento: la conversación tiene que ser de un hotel permitido (la misma
 * validación que usan bloquear y el resumen), y la consulta filtra por el
 * `hotel_id` REAL de esa conversación, nunca por uno que mande el cliente.
 *
 * Solo para quien tiene `verHistorialConversacion` (hoy, solo super_admin).
 */
import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";
import { fetchConversationHistory } from "@/lib/conversation-labels-server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    // El permiso va ANTES que validar parámetros: sin la capacidad, siempre 403.
    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verHistorialConversacion");
    if (gate.response) return gate.response;

    const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim() ?? "";
    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
    }

    const ownership = await assertConversationInHotel(supabase, conversationId, gate.allowedHotelIds);
    if (ownership.response) {
      // El 502 de la validación trae el mensaje crudo de la base: acá no sale.
      if (ownership.response.status >= 500) {
        return NextResponse.json({ error: "No se pudo leer el historial" }, { status: 502 });
      }
      return ownership.response;
    }

    const episodes = await fetchConversationHistory(supabase, ownership.hotelId, conversationId);

    // `conversationId` de vuelta para que la ficha descarte una respuesta que
    // llegó después de cambiar de conversación.
    return NextResponse.json({ conversationId, episodes });
  } catch (e) {
    const isDev = process.env.NODE_ENV !== "production";
    console.error("[inbox conversation-history GET]", isDev ? e : "fallo al leer el historial");
    return NextResponse.json({ error: "No se pudo leer el historial" }, { status: 500 });
  }
}
