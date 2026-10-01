import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { assertConversationInHotel, requireActiveHotel } from "@/lib/auth/require-hotel";
import { buildHotelWhatsappByIdMap, resolveHotelWaIdentitiesForRow } from "@/lib/hotel-whatsapp-map";
import {
  buildMessageFromWubbyRow,
  mergeConversationsTableWithMessages,
  normalizePhoneDigits,
} from "@/lib/chat-utils";
import { CONVERSATIONS_TABLE, type ConversationDbRow } from "@/lib/conversation-schema";
import {
  fetchWubbyRowsForGuestAcrossHotels,
  fetchWubbyRowsForGuestAtHotel,
} from "@/lib/inbox-fetch-messages";
import type { Message } from "@/lib/inbox-types";
import { MESSAGES_LIMIT } from "@/lib/message-limits";

export const dynamic = "force-dynamic";

const HOTELS_TABLE = "hotels";

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId")?.trim();
    const guestPhone = normalizePhoneDigits(url.searchParams.get("guestPhone")?.trim());

    if (!conversationId && !guestPhone) {
      return NextResponse.json(
        { error: "conversationId o guestPhone es obligatorio" },
        { status: 400 }
      );
    }

    // El tenant NO se confía del cliente (el frontend no envía hotelId): en modo
    // conversación se deriva de la propia fila; en el fallback por teléfono se
    // acota a los hoteles permitidos del usuario.
    const tenant = await requireActiveHotel(request, auth.user, {
      capability: "verReservas",
    });
    if (tenant.response) return tenant.response;
    const { supabase, allowedHotelIds } = tenant;

    // ── MODO SOLO TELÉFONO (sin conversationId) ────────────────────────────
    if (!conversationId) {
      if (allowedHotelIds.length === 0) {
        return NextResponse.json({
          conversation: null,
          messages: [],
          messageLimit: MESSAGES_LIMIT,
        });
      }

      const { rows, truncated } = await fetchWubbyRowsForGuestAcrossHotels(
        supabase,
        allowedHotelIds,
        guestPhone
      );
      if (truncated) {
        console.warn("[reservas messages GET] historial truncado (modo teléfono)");
      }

      const { data: hotelRows } = await supabase
        .from(HOTELS_TABLE)
        .select("id, whatsapp_number")
        .in("id", allowedHotelIds);
      const hotelWhatsappById = buildHotelWhatsappByIdMap(hotelRows ?? []);

      const guestPlus = `+${guestPhone}`;
      const messages: Message[] = rows.map((row) => {
        const identities = resolveHotelWaIdentitiesForRow(row, hotelWhatsappById);
        return buildMessageFromWubbyRow(row, guestPlus, identities).message;
      });

      return NextResponse.json({
        conversation: null,
        messages,
        messageLimit: MESSAGES_LIMIT,
      });
    }

    // ── MODO CONVERSACIÓN ──────────────────────────────────────────────────
    // 1) Ownership: deriva y valida el hotel de la conversación.
    const ownership = await assertConversationInHotel(supabase, conversationId, allowedHotelIds);
    if (ownership.response) return ownership.response;
    const activeHotelId = ownership.hotelId;

    // 2) Conversación acotada por hotel.
    const { data: convRow, error: convError } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select("*")
      .eq("id", conversationId)
      .eq("hotel_id", activeHotelId)
      .maybeSingle();

    if (convError) {
      return apiError(502, "conversation_lookup_failed", {
        cause: convError,
        log: "[reservas messages GET] conversation",
        message: "No se pudo cargar la conversación",
      });
    }
    if (!convRow) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    const cr = convRow as ConversationDbRow;
    const guestDigits = normalizePhoneDigits(cr.guest_phone ?? "") || guestPhone;

    // 3) Mensajes SOLO del huésped y SOLO de ese hotel.
    const { data: hotelRows } = await supabase
      .from(HOTELS_TABLE)
      .select("id, whatsapp_number")
      .eq("id", activeHotelId);
    const hotelWhatsappById = buildHotelWhatsappByIdMap(hotelRows ?? []);

    const { rows: msgRows, truncated } = await fetchWubbyRowsForGuestAtHotel(
      supabase,
      activeHotelId,
      guestDigits
    );
    if (truncated) {
      console.warn("[reservas messages GET] historial truncado", { conversationId, activeHotelId });
    }

    const conversations = mergeConversationsTableWithMessages([cr], msgRows, {
      hotelWhatsappById,
      messageLimit: MESSAGES_LIMIT,
    });

    return NextResponse.json({
      conversation: conversations[0] ?? null,
      messages: conversations[0]?.messages ?? [],
      messageLimit: MESSAGES_LIMIT,
    });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[reservas messages GET]", message: "No se pudo cargar la conversación" });
  }
}
