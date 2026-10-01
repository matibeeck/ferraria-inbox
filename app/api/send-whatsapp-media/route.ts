import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { assertConversationInHotel, requireActiveHotel } from "@/lib/auth/require-hotel";
import { attachWamidByClientTempId, extractWamid } from "@/lib/outbound-wamid";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { resolveConversationRecipient } from "@/lib/guest-identity-server";

export const dynamic = "force-dynamic";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PDF_MIME_TYPE = "application/pdf";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * Vida de la URL firmada que se le pasa al engine.
 *
 * Meta descarga el archivo a los segundos de aceptar el POST, así que 24 h es
 * margen de sobra incluso con los reintentos del engine. NO se hace público el
 * bucket: `hotel-media` guarda también los adjuntos ENTRANTES de los huéspedes
 * (documentos personales) y, con RLS abierto, publicarlo sería exponerlos.
 */
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/** Tope del campo `filename` en el schema del engine. */
const MAX_FILENAME_LENGTH = 240;

type WhatsappMediaType = "image" | "document";

function safeJsonParse(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const GENERIC_ENGINE_ERROR = "No se pudo enviar el archivo por WhatsApp.";

/**
 * Borra cualquier URL del texto.
 *
 * El `link` que viaja al engine es una URL FIRMADA: quien la tenga puede bajar
 * el archivo durante 24 h. Meta suele devolverla dentro del mensaje de error
 * cuando no logra descargarla, y el engine reenvía ese error tal cual. Sin esto
 * la URL terminaría en los logs del servidor y en el navegador del recepcionista.
 */
function redactUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[url]");
}

/**
 * Mensaje de error del engine para mostrar al usuario. Prioriza
 * `error`/`message`/`detail` del JSON (incluido el anidado de Meta
 * `{ error: { message } }`), que viene curado.
 *
 * Si el cuerpo no es JSON o no trae ninguna de esas claves, devuelve un
 * genérico: el crudo puede ser un stack del engine y NO debe llegar al cliente.
 */
function readEngineError(parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return redactUrls(value.trim());
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) return redactUrls(nested.trim());
      }
    }
  }
  return GENERIC_ENGINE_ERROR;
}

function readEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * URL de `POST /inbox/human-media` en el engine.
 *
 * Cada endpoint del engine tiene su propia variable con la URL completa; si no
 * está definida, se deriva del origen de la de respuestas humanas para no
 * exigir una variable nueva en el despliegue.
 */
function resolveEngineMediaUrl(): string | null {
  const explicit = process.env.ENGINE_HUMAN_MEDIA_URL?.trim();
  if (explicit) return explicit;

  const fallbackBase = process.env.ENGINE_HUMAN_REPLY_URL?.trim();
  if (!fallbackBase) return null;

  try {
    const url = new URL(fallbackBase);
    url.pathname = "/inbox/human-media";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeFilename(value: string, fallback: string): string {
  const name = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return (name || fallback).slice(0, MAX_FILENAME_LENGTH);
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === PDF_MIME_TYPE) return "pdf";
  return "jpg";
}

function validateMedia(file: File): { ok: true; whatsappType: WhatsappMediaType } | { ok: false; error: string } {
  if (ALLOWED_IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { ok: false, error: "La imagen no puede superar 5 MB" };
    }
    return { ok: true, whatsappType: "image" };
  }

  if (file.type === PDF_MIME_TYPE) {
    if (file.size > MAX_PDF_BYTES) {
      return { ok: false, error: "El PDF no puede superar 10 MB" };
    }
    return { ok: true, whatsappType: "document" };
  }

  return { ok: false, error: "Solo se permiten imágenes JPG, PNG, WebP o PDF" };
}

/**
 * Sube el adjunto a Storage y se lo entrega a ferraria-engine.
 *
 * Esta route YA NO le postea a la Graph API de Meta. Ese camino paralelo se
 * saltaba todo lo que vive en el engine (limpieza de identidades LID, el
 * `context.message_id` que hace entregable a un LID, y los reintentos de
 * errores transitorios), y por eso había huéspedes a los que les llegaba el
 * texto pero no el PDF. Ahora TODO egreso sale por el engine.
 *
 * El engine también inserta la fila en `Wubby_Whatsapp` (como `Human Answer`) y
 * mueve `conversations` (reloj de control humano), así que acá no se escribe
 * nada de eso: duplicarlo dejaría dos burbujas y dos relojes.
 *
 * Configura `ENGINE_HUMAN_MEDIA_URL` (o `ENGINE_HUMAN_REPLY_URL`) e
 * `INBOX_SHARED_SECRET`.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const formData = await request.formData();
    const conversationId = String(formData.get("conversationId") ?? "").trim();
    const toRaw = String(formData.get("to") ?? "").trim();
    const caption = String(formData.get("caption") ?? "").trim();
    const hotelIdRaw = String(formData.get("hotelId") ?? "").trim();
    const clientTempId = String(formData.get("clientTempId") ?? "").trim() || null;
    const file = formData.get("file");

    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "El archivo es obligatorio" }, { status: 400 });
    }

    const validation = validateMedia(file);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // GATE de tenancy ANTES de cualquier efecto (storage/engine):
    // 1) el hotelId del formData debe pertenecer al usuario;
    // 2) la conversación debe ser suya, y SU hotel es el autoritativo para enviar.
    const tenant = await requireActiveHotel(request, auth.user, {
      requestedHotelId: hotelIdRaw,
      capability: "enviarMensajes",
    });
    if (tenant.response) return tenant.response;
    const ownership = await assertConversationInHotel(
      tenant.supabase,
      conversationId,
      tenant.allowedHotelIds
    );
    if (ownership.response) return ownership.response;
    const hotelId = ownership.hotelId;

    // 3) el destinatario sale de la conversación validada, NUNCA del formData.
    //    El `to` se acepta por compatibilidad, pero si apunta a otro huésped no
    //    se sube ni se envía nada.
    const recipient = await resolveConversationRecipient(
      tenant.supabase,
      conversationId,
      hotelId,
      toRaw
    );
    if (!recipient.ok) {
      console.error("[send-whatsapp-media] destinatario", recipient.code);
      return NextResponse.json(
        { error: "No se encontró el número del huésped de esta conversación" },
        { status: recipient.status }
      );
    }
    if (recipient.bodyMismatch) {
      return NextResponse.json(
        { error: "El número del huésped no coincide con esta conversación. Recarga la conversación e intenta de nuevo." },
        { status: 400 }
      );
    }

    const engineUrl = resolveEngineMediaUrl();
    const sharedSecret = process.env.INBOX_SHARED_SECRET;
    if (!engineUrl || !sharedSecret) {
      return NextResponse.json(
        {
          ok: false,
          skipped: true,
          error:
            "Faltan ENGINE_HUMAN_MEDIA_URL/ENGINE_HUMAN_REPLY_URL o INBOX_SHARED_SECRET. Añádelas en .env.local para enviar archivos.",
        },
        { status: 503 }
      );
    }

    const whatsappType = validation.whatsappType;
    const isDocument = whatsappType === "document";
    const filename = sanitizeFilename(
      file.name,
      isDocument ? `documento-${Date.now()}.pdf` : `imagen-${Date.now()}.${extensionForMime(file.type)}`
    );
    const storageBucket =
      readEnv("WHATSAPP_MEDIA_BUCKET", "NEXT_PUBLIC_WHATSAPP_MEDIA_BUCKET") || "hotel-media";
    const extension = extensionForMime(file.type);
    const storagePath = `outgoing/${conversationId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const supabase = getSupabaseServerClient();
    const uploadResult = await supabase.storage.from(storageBucket).upload(storagePath, fileBuffer, {
      contentType: file.type,
      upsert: false,
    });

    if (uploadResult.error) {
      console.error("[send-whatsapp-media] upload a storage falló", uploadResult.error.message);
      return NextResponse.json({ error: "No se pudo guardar el archivo" }, { status: 502 });
    }

    // El engine NO recibe los bytes: le pasa este link a Meta y Meta descarga el
    // archivo desde sus servidores. Si la URL no es alcanzable, Meta rechaza el
    // mensaje, así que el fallo acá tiene que abortar antes de enviar nada.
    const { data: signedData, error: signedError } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    if (signedError || !signedData?.signedUrl) {
      console.error("[send-whatsapp-media] signed URL falló", signedError?.message);
      return NextResponse.json(
        { error: "No se pudo preparar el archivo para el envío" },
        { status: 502 }
      );
    }

    const res = await fetch(engineUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inbox-secret": sharedSecret,
      },
      body: JSON.stringify({
        hotelId,
        conversationId,
        // De la fila de la conversación, con la misma regla que usaba el
        // cliente: teléfono en dígitos o LID crudo (un LID se rompe si se le
        // arrancan las letras). El engine termina de limpiar la identidad.
        guestPhone: recipient.mediaIdentity,
        kind: whatsappType,
        link: signedData.signedUrl,
        filename,
        ...(caption ? { caption } : {}),
        clientTempId,
      }),
    });

    const rawBody = await res.text().catch(() => "");
    const parsedBody = safeJsonParse(rawBody);

    if (!res.ok) {
      // Solo el mensaje curado y sin URLs: el crudo trae de vuelta el `link`
      // firmado y el error completo de Meta.
      console.error("[send-whatsapp-media] engine", res.status, readEngineError(parsedBody));
      return NextResponse.json({ error: readEngineError(parsedBody) }, { status: 502 });
    }

    // El engine inserta la fila con su `wamid`; este update es el backstop para
    // las que quedaran sin él, anclado en el `client_temp_id` que el engine
    // copia a la fila. Nunca aborta: el archivo ya salió al huésped y el único
    // efecto de fallar acá es no poder cruzarlo con `message_statuses`.
    const wamid = extractWamid(parsedBody);
    if (wamid && clientTempId) {
      await attachWamidByClientTempId({ wamid, clientTempId, hotelId });
    }

    return NextResponse.json({
      ok: true,
      whatsappMessageId: wamid ?? null,
      // El cliente pinta la burbuja con estos datos hasta que Realtime traiga la
      // fila que insertó el engine.
      mediaStoragePath: storagePath,
      mediaBucket: storageBucket,
      mediaFilename: filename,
      whatsappType,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
