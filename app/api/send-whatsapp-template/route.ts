import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { fetchHotelMessageTemplateByName } from "@/lib/message-templates";
import { attachWamidToLatestOutbound, extractWamid } from "@/lib/outbound-wamid";
import { normalizeColombianWhatsappNumber } from "@/lib/whatsapp-templates";
import { readEngineError } from "@/lib/engine-error";

export const dynamic = "force-dynamic";

const GENERIC_TEMPLATE_ERROR = "No se pudo enviar la plantilla";

const HOTELS_TABLE = "hotels";

/** Copy exacto del bloqueo por hotel. Lo muestra el toast del inbox tal cual. */
const TEMPLATES_DISABLED_ERROR = "Envío de plantillas deshabilitado para este hotel";

/**
 * Detalle crudo (cuerpo del engine, mensajes de excepción) solo en desarrollo:
 * en producción puede traer teléfonos del payload de Meta o un stack.
 */
const isDev = process.env.NODE_ENV !== "production";

export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as {
      to?: string;
      templateName?: string;
      variables?: Record<string, unknown>;
      activeHotelId?: string | null;
      hotelId?: string | null;
    };

    const to = normalizeColombianWhatsappNumber(body.to ?? "");
    const templateName = body.templateName?.trim() ?? "";
    const requestedHotelId =
      (typeof body.activeHotelId === "string" ? body.activeHotelId : body.hotelId)?.trim() ?? "";

    if (!to) {
      return NextResponse.json({ error: "El número de WhatsApp es obligatorio" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "enviarMensajes");
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
      return NextResponse.json({ error: "activeHotelId es obligatorio" }, { status: 400 });
    }

    /**
     * Gate por hotel: hay hoteles donde las plantillas no se pueden facturar en
     * Meta, así que el envío manual queda cerrado hasta que eso se resuelva.
     *
     * Va DESPUÉS de auth y del gate de hotel —primero se comprueba que el
     * usuario tenga derecho a este hotel, y recién ahí qué permite el hotel— y
     * ANTES de tocar el engine: nada sale si el flag está apagado.
     *
     * Obligatorio aunque la UI esconda el botón: el front es una comodidad, no
     * un candado. Filtra por `hotel_id` en el query, sin apoyarse en RLS.
     *
     * Solo un `true` explícito deja pasar. Fila ausente o columna null caen del
     * lado cerrado, que acá es el barato: un envío de más no se puede deshacer.
     */
    const { data: hotelFlagRow, error: hotelFlagError } = await supabase
      .from(HOTELS_TABLE)
      .select("templates_enabled")
      .eq("id", activeHotelId)
      .maybeSingle();

    if (hotelFlagError) {
      // Sin PII: solo el code de Supabase.
      console.error(
        "[send-whatsapp-template] templates_enabled",
        hotelFlagError.code ?? "sin_code"
      );
      return NextResponse.json({ error: GENERIC_TEMPLATE_ERROR }, { status: 502 });
    }

    if (hotelFlagRow?.templates_enabled !== true) {
      return NextResponse.json({ error: TEMPLATES_DISABLED_ERROR }, { status: 403 });
    }

    if (!templateName) {
      return NextResponse.json({ error: "La plantilla es obligatoria" }, { status: 400 });
    }

    const template = await fetchHotelMessageTemplateByName(supabase, activeHotelId, templateName);
    if (!template) {
      return NextResponse.json({ error: "Plantilla no válida para este hotel" }, { status: 400 });
    }

    const variables: Record<string, string> = {};
    for (const variable of template.variables) {
      const value = String(body.variables?.[variable.key] ?? "").trim();
      if (!value) {
        return NextResponse.json(
          { error: `La variable ${variable.key} es obligatoria` },
          { status: 400 }
        );
      }
      variables[variable.key] = value;
    }

    const payload = {
      to,
      templateName,
      activeHotelId,
      ...(template.variables.length > 0 ? { variables } : {}),
    };

    // Sin URL o sin secreto NO hay envío: fallar explícito, nunca caer a un
    // destino por defecto.
    const engineUrl = process.env.ENGINE_SEND_TEMPLATE_URL;
    const sharedSecret = process.env.INBOX_SHARED_SECRET;
    if (!engineUrl || !sharedSecret) {
      console.error(
        "[send-whatsapp-template] faltan ENGINE_SEND_TEMPLATE_URL o INBOX_SHARED_SECRET"
      );
      return NextResponse.json(
        {
          error:
            "Envío no configurado: faltan ENGINE_SEND_TEMPLATE_URL o INBOX_SHARED_SECRET",
        },
        { status: 500 }
      );
    }

    const res = await fetch(engineUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inbox-secret": sharedSecret,
      },
      body: JSON.stringify(payload),
    });

    // El engine devuelve el resultado real de Meta (n8n devolvía "[object
    // Object]"): lo parseamos para propagar el motivo real del fallo.
    const raw = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      // En producción solo el status: el crudo puede traer el payload de Meta.
      console.error("[send-whatsapp-template] engine", res.status, isDev ? raw : "");
      return NextResponse.json(
        { error: readEngineError(parsed, GENERIC_TEMPLATE_ERROR) },
        { status: 502 }
      );
    }

    // La fila "Human Template" la inserta quien envía (engine o n8n), así que
    // acá solo queda completarle el `wamid` para poder cruzarla después con
    // `message_statuses` y marcar la burbuja como no entregada.
    //
    // A diferencia del texto humano, este camino NO lleva `clientTempId`: el
    // ancla es (hotel, sender sintético, destinatario, wamid IS NULL) tomando
    // la fila más reciente, que es la recién insertada. Fallar acá no deshace
    // el envío, solo deja ese mensaje sin rastrear.
    const wamid = extractWamid(parsed);
    if (wamid) {
      await attachWamidToLatestOutbound({
        wamid,
        hotelId: activeHotelId,
        sender: "Human Template",
        // El engine guarda el teléfono en dígitos; n8n copia el `to` del
        // payload tal cual. Se cubren ambas formas, con y sin `+`.
        recipientCandidates: [to, `+${to}`],
      });
    }

    return NextResponse.json({ ok: true, result: parsed });
  } catch (e) {
    console.error(
      "[send-whatsapp-template] error inesperado",
      isDev ? e : e instanceof Error ? e.name : "unknown"
    );
    return NextResponse.json(
      { error: isDev && e instanceof Error ? e.message : GENERIC_TEMPLATE_ERROR },
      { status: 500 }
    );
  }
}
