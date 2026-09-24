import { NextResponse } from "next/server";
import { buildMessageFromWubbyRow, normalizeWaIdentity } from "@/lib/chat-utils";
import { CONVERSATIONS_TABLE } from "@/lib/conversation-schema";
import { fetchConversationMessagePage } from "@/lib/inbox-fetch-messages";
import { parseKeysetCursor } from "@/lib/inbox-keyset";
import { fetchReceiptsForWamids, uniqueWamids } from "@/lib/message-statuses-server";
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

/**
 * Mensajes por página. Una pantalla de hilo muestra ~15 burbujas: 50 dan
 * contexto de sobra al abrir y el resto se pide con "Cargar anteriores"
 * (`?before=<created_at>|<id>`). Antes se traía el hilo COMPLETO en páginas
 * seriales de hasta 15.000 filas.
 */
const MESSAGES_PAGE_SIZE = 50;

const isDev = process.env.NODE_ENV !== "production";

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

    const beforeRaw = url.searchParams.get("before")?.trim() ?? "";
    const cursor = beforeRaw ? parseKeysetCursor(beforeRaw) : null;
    if (beforeRaw && !cursor) {
      return NextResponse.json({ error: "Cursor de página inválido" }, { status: 400 });
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

    // Candado de tenencia: la conversación tiene que ser del hotel activo, que
    // ya se validó contra los hoteles del usuario. Va ANTES de leer un solo
    // mensaje. Solo la columna que se usa: el teléfono para el respaldo por
    // identidad y para clasificar las burbujas.
    const { data: convRow, error: convError } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select("id, guest_phone")
      .eq("id", conversationId)
      .eq("hotel_id", activeHotelId)
      .maybeSingle();

    if (convError) {
      console.error("[inbox messages GET] conversation", convError.code ?? "sin_code");
      return NextResponse.json(
        { error: isDev ? convError.message : "No se pudo leer la conversación" },
        { status: 502 }
      );
    }
    if (!convRow) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    const cr = convRow as { id: string; guest_phone: string | null };
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

    // Últimos 50 (o los 50 anteriores al cursor): `conversation_id` como
    // criterio principal y, en paralelo, la identidad del huésped para las
    // filas sin `conversation_id`. Ver `fetchConversationMessagePage`.
    const page = await fetchConversationMessagePage(supabase, {
      hotelId: activeHotelId,
      conversationId,
      guestIdentity: guestPhoneRaw || guestPhone,
      cursor,
      limit: MESSAGES_PAGE_SIZE,
    });

    // Acuses de Meta SOLO de los wamids de esta página: dependen de las filas
    // que acaban de llegar, que ya vienen filtradas por hotel y conversación.
    // Antes eran un request aparte con tres consultas en serie.
    const statuses = await fetchReceiptsForWamids(
      supabase,
      uniqueWamids(page.rows.map((row) => row.wamid))
    );

    const messages: Message[] = page.rows.map((row) => {
      const identities = resolveHotelWaIdentitiesForRow(row, hotelWhatsappById);
      return buildMessageFromWubbyRow(row, guestPhone, identities).message;
    });

    return NextResponse.json({
      conversationId,
      guestPhone: guestPhone || guestPhoneRaw,
      messages,
      fetchedCount: messages.length,
      // "Cargar anteriores": se pide con `?before=<olderCursor>`.
      hasOlder: page.hasOlder,
      olderCursor: page.olderCursor,
      // wamid → status / error_code / error_title de los mensajes de ESTA
      // página. El cliente los suma a los que ya tiene.
      statuses,
    });
  } catch (e) {
    // El mensaje puede traer el detalle crudo de Supabase: solo fuera de producción.
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[inbox messages GET]", isDev ? e : "error al leer el hilo");
    return NextResponse.json(
      { error: isDev ? msg : "No se pudo cargar el historial" },
      { status: 500 }
    );
  }
}
