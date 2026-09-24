import { NextResponse } from "next/server";
import { buildMessageFromWubbyRow, normalizeWaIdentity } from "@/lib/chat-utils";
import { CONVERSATIONS_TABLE, type ConversationDbRow } from "@/lib/conversation-schema";
import { fetchWubbyRowsForGuestAtHotel } from "@/lib/inbox-fetch-messages";
import {
  buildHotelWhatsappByIdMap,
  resolveHotelWaIdentitiesForRow,
} from "@/lib/hotel-whatsapp-map";
import { availableHotelsFrom, resolveActiveHotelId } from "@/lib/inbox-tenant";
import type { Message } from "@/lib/inbox-types";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId")?.trim() ?? "";
    const requestedHotelId = url.searchParams.get("hotelId")?.trim() ?? "";

    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    // Filas de `hotels` ya leídas por el gate, recortadas a lo que este endpoint
    // puede ver: selector y `whatsapp_number` sin viajes extra.
    const allowedSet = new Set(allowedHotelIds);
    const hotelRows = gate.tenant.hotels.filter((hotel) => allowedSet.has(hotel.id));
    const availableHotels = availableHotelsFrom(hotelRows, allowedHotelIds);
    const { activeHotelId, forbidden } = resolveActiveHotelId(
      requestedHotelId,
      allowedHotelIds,
      availableHotels
    );

    if (forbidden) {
      return NextResponse.json({ error: "No autorizado para ver este hotel" }, { status: 403 });
    }
    if (!activeHotelId) {
      return NextResponse.json({ error: "hotelId es obligatorio" }, { status: 400 });
    }

    const { data: convRow, error: convError } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select("*")
      .eq("id", conversationId)
      .eq("hotel_id", activeHotelId)
      .maybeSingle();

    if (convError) {
      console.error("[inbox messages GET] conversation", convError);
      return NextResponse.json({ error: convError.message }, { status: 502 });
    }
    if (!convRow) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    const cr = convRow as ConversationDbRow;
    // Identidad del huésped: `+E.164` si es teléfono, o el LID crudo de Meta.
    // Se usa para el filtro complementario y para clasificar cada burbuja.
    const guestPhone = normalizeWaIdentity(cr.guest_phone ?? "");
    const guestPhoneRaw = String(cr.guest_phone ?? "").trim();
    if (!guestPhone && !guestPhoneRaw) {
      return NextResponse.json({ error: "La conversación no tiene teléfono de huésped" }, { status: 400 });
    }

    // `whatsapp_number` del hotel activo, resuelto por `hotel_id` desde `hotels`.
    const activeHotelRow = hotelRows.find((hotel) => hotel.id === activeHotelId);
    const hotelWhatsappById = buildHotelWhatsappByIdMap(
      activeHotelRow ? [{ id: activeHotelId, whatsapp_number: activeHotelRow.whatsappNumber }] : []
    );

    // `conversationId` como criterio principal; la identidad queda de respaldo
    // para las filas antiguas sin `conversation_id`.
    const { rows: msgRows, truncated } = await fetchWubbyRowsForGuestAtHotel(
      supabase,
      activeHotelId,
      guestPhoneRaw || guestPhone,
      conversationId
    );
    if (truncated) {
      console.warn("[inbox messages GET] historial truncado", { conversationId, activeHotelId });
    }

    const messages: Message[] = msgRows.map((row) => {
      const identities = resolveHotelWaIdentitiesForRow(row, hotelWhatsappById);
      return buildMessageFromWubbyRow(row, guestPhone, identities).message;
    });

    return NextResponse.json({
      conversationId,
      guestPhone: guestPhone || guestPhoneRaw,
      messages,
      fetchedCount: messages.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[inbox messages GET]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
