import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { assertConversationInHotel, requireActiveHotel } from "@/lib/auth/require-hotel";
import {
  MAX_STATUS_WAMIDS,
  fetchReceiptsForWamids,
  uniqueWamids,
} from "@/lib/message-statuses-server";
import { WUBBY_TABLE } from "@/lib/wubby-schema";

export const dynamic = "force-dynamic";

/**
 * Forma de un wamid de Meta (`wamid.` + base64). Nada que no calce entra al
 * `.in()`: el valor viene del navegador.
 */
const WAMID_PATTERN = /^[A-Za-z0-9._=+/-]{8,200}$/;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/conversations/[id]/message-statuses?hotelId=…&wamids=a,b,c
 *
 * Refresco puntual de acuses de Meta —sent, delivered, read, failed— para los
 * wamids que pide el cliente. Hoy lo usa solo el refetch de 6 s tras enviar:
 * al abrir el hilo, los acuses ya vienen en `GET /api/inbox/messages` junto
 * con cada página.
 *
 * Antes este endpoint releía hasta 250 filas de `Wubby_Whatsapp` por teléfono
 * en cada llamada para sacar los wamids. Ahora los trae el cliente, y el
 * servidor solo comprueba que sean de un hotel del usuario y de ESTA
 * conversación (o de una fila vieja sin `conversation_id`) antes de cruzarlos.
 *
 * Sin `wamids` responde vacío: un cliente de antes del cambio se queda con los
 * acuses que ya tenía, sin error.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const conversationId = (await context.params).id?.trim();
    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
    }

    const tenant = await requireActiveHotel(request, auth.user, {
      capability: "verConversacionesHuespedes",
    });
    if (tenant.response) return tenant.response;

    const requested = uniqueWamids(
      (new URL(request.url).searchParams.get("wamids") ?? "").split(",")
    )
      .filter((wamid) => WAMID_PATTERN.test(wamid))
      .slice(0, MAX_STATUS_WAMIDS);
    if (requested.length === 0) {
      return NextResponse.json({ statuses: [] });
    }

    // Independientes: el dueño de la conversación y las filas de esos wamids
    // dentro de los hoteles permitidos. El cruce de las dos va después.
    const [ownership, wubby] = await Promise.all([
      assertConversationInHotel(tenant.supabase, conversationId, tenant.allowedHotelIds),
      tenant.supabase
        .from(WUBBY_TABLE)
        .select("wamid, hotel_id, conversation_id")
        .in("hotel_id", tenant.allowedHotelIds)
        .in("wamid", requested)
        .limit(MAX_STATUS_WAMIDS * 2),
    ]);
    if (ownership.response) return ownership.response;

    if (wubby.error) {
      console.error("[message-statuses] lookup wamids", wubby.error.code ?? "sin_code");
      return NextResponse.json({ error: "No se pudieron leer los mensajes" }, { status: 502 });
    }

    // Solo cruzan los wamids de ESTE hotel y de ESTA conversación (o de filas
    // viejas que nunca tuvieron `conversation_id`).
    const allowed = uniqueWamids(
      ((wubby.data ?? []) as Array<{
        wamid: string | null;
        hotel_id: string | null;
        conversation_id: string | null;
      }>)
        .filter(
          (row) =>
            row.hotel_id === ownership.hotelId &&
            (row.conversation_id === conversationId || row.conversation_id == null)
        )
        .map((row) => row.wamid)
    );

    const statuses = await fetchReceiptsForWamids(tenant.supabase, allowed);
    return NextResponse.json({ statuses });
  } catch (e) {
    console.error("[message-statuses]", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Error desconocido" }, { status: 500 });
  }
}
