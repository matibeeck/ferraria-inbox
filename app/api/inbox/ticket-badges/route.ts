/**
 * Refresco de los badges de solicitud, SIN recargar la bandeja.
 *
 * Existe porque `service_tickets` no viaja por Realtime: el inbox solo escucha
 * `conversations` y los mensajes, así que cuando alguien resuelve una solicitud
 * desde la pestaña Solicitudes (normalmente en OTRA tablet, la del personal
 * operativo) la bandeja de recepción no se entera de nada.
 *
 * La alternativa era recargar `/api/inbox` cada minuto: ~570 kB por vuelta en
 * el hotel más grande, todo el turno, por cada bandeja abierta. Esta respuesta
 * son unos pocos kB porque no trae conversaciones ni mensajes, solo el mapa de
 * `conversation_id` → badge.
 */
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireSessionUser } from "@/lib/auth/require-user";
import { fetchTicketBadges } from "@/lib/inbox-ticket-badges-server";
import { ticketBadgesToRecord } from "@/lib/inbox-ticket-badges";
import { resolveActiveHotelId, resolveAvailableHotels } from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const supabase = getSupabaseServerClient();
    // MISMA capacidad que la bandeja: quien no puede ver conversaciones de
    // huéspedes tampoco puede sacar por acá qué habitación pidió qué cosa.
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;

    const allowedHotelIds = gate.allowedHotelIds;
    const requestedHotelId = new URL(request.url).searchParams.get("hotelId")?.trim() ?? "";
    const availableHotels = await resolveAvailableHotels(supabase, allowedHotelIds);
    const { activeHotelId, forbidden } = resolveActiveHotelId(
      requestedHotelId,
      allowedHotelIds,
      availableHotels
    );

    if (forbidden) {
      return NextResponse.json({ error: "No autorizado para ver este hotel" }, { status: 403 });
    }

    if (allowedHotelIds.length === 0 || !activeHotelId) {
      return NextResponse.json({ ticketBadges: {}, activeHotelId });
    }

    const badges = await fetchTicketBadges(supabase, activeHotelId);

    // `activeHotelId` va de vuelta para que el cliente descarte una respuesta
    // que llegó después de un cambio de hotel. Sin eso, los badges del hotel
    // anterior se pegarían sobre la bandeja del nuevo.
    return NextResponse.json({
      ticketBadges: ticketBadgesToRecord(badges),
      activeHotelId,
    });
  } catch (e) {
    console.error("[inbox ticket-badges GET]", e);
    // El refresco es best-effort: el cliente ignora el error y se queda con los
    // badges que ya tiene. Nada de detalles crudos en la respuesta.
    return NextResponse.json({ error: "No se pudieron leer las solicitudes" }, { status: 500 });
  }
}
