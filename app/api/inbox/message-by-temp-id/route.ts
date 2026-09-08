import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { assertConversationInHotel, requireActiveHotel } from "@/lib/auth/require-hotel";
import { findOutboundByClientTempId } from "@/lib/outbound-wamid";

export const dynamic = "force-dynamic";

/**
 * "¿Ya quedó guardado el mensaje que acabo de enviar?"
 *
 * Red de seguridad de la burbuja optimista. La bandeja la consulta en dos
 * momentos, los dos con el mismo `client_temp_id` que generó al enviar:
 *
 * 1. A los 8 s, si la burbuja sigue en "Enviando…" (la respuesta HTTP del envío
 *    se perdió, típicamente porque la red se cayó justo después del POST).
 * 2. De inmediato, cuando el engine devuelve un error genérico. Ahí NO sabemos
 *    si el mensaje salió o no, y decirle a la recepcionista "No se envió" sin
 *    saberlo la empuja a reenviar y a duplicarle el mensaje al huésped.
 *
 * Deliberadamente NO reusa `GET /api/inbox/messages`: esa ruta barre el
 * historial completo del huésped paginando hasta 15.000 filas. Dispararla cada
 * 8 s por burbuja sería un martillo sobre `Wubby_Whatsapp`. Acá es una sola
 * fila por el índice `(hotel_id, client_temp_id)`.
 *
 * Tampoco devuelve el mensaje entero: la burbuja ya tiene el texto en pantalla.
 * Solo necesita saber si existe, con qué `id` real y con qué `wamid`.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId")?.trim() ?? "";
    const clientTempId = url.searchParams.get("clientTempId")?.trim() ?? "";
    const requestedHotelId = url.searchParams.get("hotelId")?.trim() ?? "";

    if (!conversationId || !clientTempId) {
      return NextResponse.json(
        { error: "conversationId y clientTempId son obligatorios" },
        { status: 400 }
      );
    }

    // Mismo gate que el envío: quien puede mandar el mensaje es quien puede
    // reconciliar su propia burbuja.
    const tenant = await requireActiveHotel(request, auth.user, {
      requestedHotelId: requestedHotelId || undefined,
      capability: "enviarMensajes",
    });
    if (tenant.response) return tenant.response;

    // El `hotel_id` sale de la conversación, NUNCA del cliente: el que llega por
    // query string solo sirve para elegir hotel activo, y aun así se valida
    // contra los hoteles del usuario.
    const ownership = await assertConversationInHotel(
      tenant.supabase,
      conversationId,
      tenant.allowedHotelIds
    );
    if (ownership.response) return ownership.response;

    const found = await findOutboundByClientTempId({
      clientTempId,
      hotelId: ownership.hotelId,
    });

    // `unknown` (no pudimos consultar) NO es `absent`. Si se colapsaran, la
    // bandeja marcaría "No se envió" un mensaje que quizá sí salió, la
    // recepcionista reintentaría y el huésped lo recibiría dos veces. Un 503 la
    // deja en "Enviando…", que es la verdad.
    if (found.status === "unknown") {
      return NextResponse.json(
        { error: "No se pudo verificar el estado del mensaje" },
        { status: 503 }
      );
    }

    if (found.status === "absent") {
      return NextResponse.json({ found: false });
    }

    return NextResponse.json({
      found: true,
      messageId: found.messageId,
      whatsappMessageId: found.wamid,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[inbox message-by-temp-id GET]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
