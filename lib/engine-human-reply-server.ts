import { randomUUID } from "node:crypto";
import { construirPayloadHumanReply } from "@/lib/engine-human-reply-payload";
import { attachWamidByClientTempId, extractWamid } from "@/lib/outbound-wamid";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * Envío de un texto "humano" al huésped desde el SERVIDOR del inbox, por el
 * mismo endpoint del engine que usa el composer: `POST /inbox/human-reply`
 * (`ENGINE_HUMAN_REPLY_URL` + `INBOX_SHARED_SECRET`). No hay cliente de Meta
 * propio: el engine es quien manda, traduce si se le pide, inserta la fila en
 * `Wubby_Whatsapp` y, en hoteles que siguen en n8n, hace proxy al webhook de
 * siempre.
 *
 * El payload (`lib/engine-human-reply-payload.ts`) replica el contrato de
 * `app/api/send-human-message/route.ts` campo por campo, más `automatico`.
 * Esa ruta no se tocó a propósito (es la que usa recepción para contestar en
 * vivo); si su payload cambia, este también.
 *
 * Lo usa hoy el aviso de cierre de solicitudes (`lib/aviso-cierre-server.ts`).
 */

const isDev = process.env.NODE_ENV !== "production";

/**
 * Errores del engine que GARANTIZAN que no salió nada al huésped (la
 * traducción se hace antes de hablar con Meta). Mismo set que el composer.
 */
const ERRORES_SIN_ENVIO = new Set([
  "translation_failed",
  "invalid_target_lang",
  "conflicting_target_lang",
  "translation_not_supported",
]);

/** Tope de espera al engine. Más allá, el PATCH no puede dejar colgada la tablet. */
const TIMEOUT_MS = 15_000;

export type ResultadoEnvioHumano =
  | { ok: true; wamid: string | null }
  | {
      ok: false;
      /** `true` solo cuando hay garantía de que el huésped NO recibió nada. */
      seguroQueNoSalio: boolean;
      codigo: string | null;
      status: number | null;
    };

async function leerConfigWhatsappHotel(hotelId: string): Promise<{
  whatsappPhoneNumberId: string | null;
  whatsappNumber: string | null;
}> {
  const vacio = { whatsappPhoneNumberId: null, whatsappNumber: null };
  try {
    const { data, error } = await getSupabaseServerClient()
      .from("hotels")
      .select("whatsapp_phone_number_id, whatsapp_number")
      .eq("id", hotelId)
      .maybeSingle();
    if (error) {
      console.error("[engine-human-reply] hotel lookup failed", isDev ? error : error.code);
      return vacio;
    }
    return {
      whatsappPhoneNumberId: data?.whatsapp_phone_number_id ?? null,
      whatsappNumber: data?.whatsapp_number ?? null,
    };
  } catch (e) {
    console.error("[engine-human-reply] hotel lookup exception", isDev ? e : "error inesperado");
    return vacio;
  }
}

function leerJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function enviarTextoHumanoPorEngine(input: {
  /** Identidad del huésped tal como la espera el engine (dígitos o LID crudo). */
  guestPhone: string;
  message: string;
  conversationId: string;
  /** Hotel AUTORITATIVO (el de la fila verificada), nunca uno del cliente. */
  hotelId: string;
  /** ISO 639-1 distinto de español, o `null` para mandarlo tal cual. */
  targetLang: string | null;
  /** Ver `EntradaPayloadHumanReply.automatico`. */
  automatico: boolean;
}): Promise<ResultadoEnvioHumano> {
  const engineUrl = process.env.ENGINE_HUMAN_REPLY_URL;
  const sharedSecret = process.env.INBOX_SHARED_SECRET;
  if (!engineUrl || !sharedSecret) {
    console.error("[engine-human-reply] faltan ENGINE_HUMAN_REPLY_URL o INBOX_SHARED_SECRET");
    return { ok: false, seguroQueNoSalio: true, codigo: "engine_no_configurado", status: null };
  }

  const hotelWhatsapp = await leerConfigWhatsappHotel(input.hotelId);
  // UUID propio por envío: el engine lo copia a la fila y es el ancla del
  // backstop de `wamid`, igual que en el composer.
  const clientTempId = randomUUID();

  const payload = construirPayloadHumanReply({
    guestPhone: input.guestPhone,
    message: input.message,
    targetLang: input.targetLang,
    conversationId: input.conversationId,
    hotelId: input.hotelId,
    whatsappPhoneNumberId: hotelWhatsapp.whatsappPhoneNumberId,
    whatsappNumber: hotelWhatsapp.whatsappNumber,
    sentAt: new Date().toISOString(),
    clientTempId,
    automatico: input.automatico,
  });

  let res: Response;
  try {
    res = await fetch(engineUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-inbox-secret": sharedSecret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Timeout o red caída: el engine pudo haberlo mandado igual. No hay
    // garantía de nada, así que quien llama no puede reintentar a ciegas.
    const nombre = e instanceof Error ? e.name : "error";
    console.error("[engine-human-reply] fetch failed", nombre);
    return { ok: false, seguroQueNoSalio: false, codigo: null, status: null };
  }

  const rawBody = await res.text().catch(() => "");
  const body = leerJson(rawBody) as { error?: unknown } | null;

  if (!res.ok) {
    const codigo = typeof body?.error === "string" ? body.error : null;
    // Solo status y código: el cuerpo crudo puede traer el teléfono del huésped.
    console.error("[engine-human-reply]", res.status, codigo ?? "sin código");
    return {
      ok: false,
      seguroQueNoSalio: codigo !== null && ERRORES_SIN_ENVIO.has(codigo),
      codigo,
      status: res.status,
    };
  }

  const wamid = extractWamid(body);
  if (wamid) {
    await attachWamidByClientTempId({ wamid, clientTempId, hotelId: input.hotelId });
  }
  return { ok: true, wamid: wamid ?? null };
}
