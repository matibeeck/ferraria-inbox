import {
  channelLabel,
  isOtaChannel,
  normalizeChannel,
  pickEngineIdentity,
  type MessageChannel,
} from "@/lib/channels";
import type { ConversationDbRow } from "@/lib/conversation-schema";
import type { ControlMode, Conversation, Message, MessageSender, OperationalStatus } from "@/lib/inbox-types";
import {
  type HotelWhatsappByIdMap,
  resolveHotelWaIdentitiesForRow,
} from "@/lib/hotel-whatsapp-map";
import { MESSAGES_LIMIT } from "@/lib/message-limits";
import { truncateListPreview } from "@/lib/inbox-preview";
import {
  COLOMBIA_TIME_ZONE,
  parseWhatsappInstant,
  parseWhatsappInstantMs,
} from "@/lib/meta-window";
import type { WubbyWhatsappRow } from "@/lib/wubby-schema";

/**
 * Teléfono solo dígitos para comparar identidades (Twilio `whatsapp:+…`, Meta sin prefijo, etc.).
 */
export function normalizePhoneDigits(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/whatsapp:/gi, "")
    .replace(/\+/g, "")
    .replace(/\s/g, "")
    .replace(/\D/g, "");
}

/**
 * Identificador LID de Meta (p. ej. `CO.28322187600722863`), que llega en lugar
 * del teléfono cuando el huésped oculta su número.
 *
 * Se detecta por FORMA, no por prefijo: sin espacios, con punto, solo
 * alfanumérico y con al menos 5 dígitos. Los literales `"Human Answer"` y
 * `"Human Template"` llevan espacio, así que nunca caen acá y la clasificación
 * de remitente sigue intacta. Un teléfono normal tampoco entra: no tiene punto.
 *
 * Importa porque `normalizePhoneDigits` le arranca las letras y produce un
 * "teléfono" inventado (`28322187600722863`) que no matchea ninguna fila.
 */
export function isWaLidIdentifier(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim().replace(/whatsapp:/gi, "");
  if (!raw || /\s/.test(raw)) return false;
  if (!raw.includes(".")) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return false;
  return raw.replace(/\D/g, "").length >= 5;
}

/** LID tal cual: solo se le quita el prefijo `whatsapp:` y los bordes. */
export function readWaLid(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/whatsapp:/gi, "");
}

/**
 * Clave de identidad del huésped para AGRUPAR y comparar: LID crudo, o teléfono
 * en dígitos sin `+`. Es la clave de los `Map` de mensajes por huésped, así que
 * tiene que coincidir con la que se usa al buscar en ese `Map`.
 */
export function normalizeGuestIdentityKey(value: string | null | undefined): string {
  if (isWaLidIdentifier(value)) return readWaLid(value);
  return normalizePhoneDigits(value);
}

/**
 * Identidad del huésped tal como la espera el engine en `/inbox/human-reply`.
 *
 * Son DOS reglas distintas según el canal y mezclarlas rompe el envío:
 *
 * - WhatsApp: dígitos del teléfono (o el LID crudo). Es lo de siempre.
 * - OTA: el `guest_phone` SIN TOCAR, porque es el UUID del hilo de Channex y el
 *   engine busca la conversación con `guest_phone = ?` exacto. Si se le manda la
 *   versión normalizada —que le arranca los guiones— la búsqueda no encuentra
 *   nada, el engine concluye que no es OTA y se va por el camino de WhatsApp
 *   con un número inventado de 19 dígitos.
 *
 * Por eso no alcanza con "dejar de bloquear el compositor": sin esto, responder
 * en un hilo de Booking se sale por el canal equivocado.
 */
export function resolveEngineGuestIdentity(conversation: {
  channel: MessageChannel;
  guestPhone: string;
  guestPhoneRaw: string;
}): string {
  return pickEngineIdentity(
    conversation.channel,
    conversation.guestPhoneRaw,
    normalizeGuestIdentityKey(conversation.guestPhone)
  );
}

export function parseHotelPhoneDigitsCsv(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => normalizePhoneDigits(value))
    .filter(Boolean);
}

export function getHotelPhoneDigitsFromEnv(): string[] {
  const values = parseHotelPhoneDigitsCsv(
    process.env.HOTEL_WHATSAPP_PHONE_DIGITS ??
      process.env.NEXT_PUBLIC_HOTEL_WHATSAPP_PHONE_DIGITS
  );

  if (values.length > 0) {
    return values;
  }

  // Fallback seguro para desarrollo: sin líneas reales hardcodeadas.
  // En producción configura HOTEL_WHATSAPP_PHONE_DIGITS o
  // NEXT_PUBLIC_HOTEL_WHATSAPP_PHONE_DIGITS en Vercel.
  return [];
}

/** Líneas WhatsApp del hotel en dígitos, leídas desde variables de entorno. */
export const DEFAULT_HOTEL_PHONE_DIGITS = getHotelPhoneDigitsFromEnv();

/**
 * Identidad WhatsApp/Twilio normalizada para comparar (+E.164), o el LID crudo
 * cuando el remitente es un identificador de Meta.
 *
 * Nunca antepone `+` a un LID: `+CO.28322187600722863` no es un teléfono y se
 * mostraba así en el panel de datos. Las líneas del hotel son siempre numéricas,
 * de modo que su normalización no cambia.
 */
export function normalizeWaIdentity(raw: string | null | undefined): string {
  if (isWaLidIdentifier(raw)) return readWaLid(raw);
  const digits = normalizePhoneDigits(raw);
  return digits ? `+${digits}` : "";
}

export type ResolveHotelWaIdentitiesOptions = {
  /** Si viene definido (p. ej. `TWILIO_WHATSAPP_ADDRESS`), se fusiona al conjunto. */
  twilioEnv?: string | null;
  /** CSV opcional adicional para pruebas o inyección explícita. */
  extraCsvEnv?: string | null;
};

/**
 * Conjunto de líneas del hotel (+E.164) para routing y clasificación de burbujas.
 * En producción configura `HOTEL_WHATSAPP_PHONE_DIGITS` (server) o
 * `NEXT_PUBLIC_HOTEL_WHATSAPP_PHONE_DIGITS` si la clasificación corre en cliente.
 */
export function resolveHotelWaIdentitiesSet(opts?: ResolveHotelWaIdentitiesOptions): Set<string> {
  const set = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const id = normalizeWaIdentity(raw);
    if (id) set.add(id);
  };

  for (const digits of DEFAULT_HOTEL_PHONE_DIGITS) {
    add(String(digits));
  }

  add(opts?.twilioEnv ?? process.env.TWILIO_WHATSAPP_ADDRESS);
  add(process.env.WHATSAPP_BUSINESS_PHONE_NUMBER);
  add(process.env.META_WHATSAPP_BUSINESS_PHONE);

  const csv =
    opts?.extraCsvEnv ??
    process.env.HOTEL_WHATSAPP_PHONE_DIGITS ??
    process.env.NEXT_PUBLIC_HOTEL_WHATSAPP_PHONE_DIGITS;
  if (csv) {
    for (const part of csv.split(",")) add(part.trim());
  }

  return set;
}

function inferDominantWaBusinessIdentity(rows: WubbyWhatsappRow[]): string | null {
  const counts = countIdentityOccurrences(rows);
  let best: string | null = null;
  let max = 0;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

function countIdentityOccurrences(rows: WubbyWhatsappRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const side of [row.sender, row.recipient]) {
      const id = normalizeWaIdentity(typeof side === "string" ? side : String(side ?? ""));
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Primera línea de negocio inferida (compatibilidad); preferir `resolveHotelWaIdentitiesSet`.
 * Si hay números conocidos por env/constantes, devuelve uno de ellos; si no, la identidad más frecuente en el histórico.
 */
export function inferTwilioIdentity(rows: WubbyWhatsappRow[], envTwilio?: string | null): string | null {
  const known = resolveHotelWaIdentitiesSet({ twilioEnv: envTwilio });
  const firstKnown = known.values().next().value as string | undefined;
  if (firstKnown) return firstKnown;
  return inferDominantWaBusinessIdentity(rows);
}

function isHumanAnswerSender(raw: string | null | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase() === "human answer";
}

/** Dígitos del hotel desde el Set (+E.164) de resolveHotelWaIdentitiesForRow. */
function hotelPhoneDigitsFromIdentities(hotelIdentities: Set<string>): string {
  const first = hotelIdentities.values().next().value as string | undefined;
  return first ? normalizePhoneDigits(first) : "";
}

/**
 * Teléfono del huésped para agrupar mensajes: solo dígitos (sin +).
 * Hotel = línea del mapa por hotel_id; "Human Answer" → huésped en recipient.
 */
export function inferGuestPhone(row: WubbyWhatsappRow, hotelIdentities: Set<string>): string {
  const senderRaw = String(row.sender ?? "").trim();
  const recipientRaw = String(row.recipient ?? "").trim();
  // Clave LID-aware: un huésped con LID se agrupa por su identificador crudo,
  // no por los dígitos que quedarían al arrancarle las letras.
  const senderKey = normalizeGuestIdentityKey(senderRaw);
  const recipientKey = normalizeGuestIdentityKey(recipientRaw);
  const hotelDigits = hotelPhoneDigitsFromIdentities(hotelIdentities);

  if (isHumanAnswerSender(senderRaw)) {
    return recipientKey || "unknown";
  }
  if (hotelDigits && senderKey && senderKey === hotelDigits) {
    return recipientKey || "unknown";
  }
  return senderKey || recipientKey || "unknown";
}

export function getRowField(row: WubbyWhatsappRow, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in row && row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** Columna `format` en Wubby_Whatsapp (`audio`, `text`, …). */
export function readMessageFormat(row: WubbyWhatsappRow): string | undefined {
  const v = getRowField(row, "format", "Format");
  if (v == null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function readStringField(row: WubbyWhatsappRow, ...keys: string[]): string | undefined {
  const v = getRowField(row, ...keys);
  if (v == null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function readMediaUrl(row: WubbyWhatsappRow): string | undefined {
  return readStringField(
    row,
    "media_url",
    "mediaUrl",
    "Media_Url",
    "Media_URL",
    "image_url",
    "imageUrl",
    "file_url",
    "fileUrl",
    "url"
  );
}

function readMediaMimeType(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "media_mime_type", "mediaMimeType", "mime_type", "Mime_Type");
}

function readMediaStoragePath(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "media_storage_path", "mediaStoragePath", "storage_path");
}

function readMediaCaption(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "media_caption", "mediaCaption", "caption");
}

function readMediaFilename(row: WubbyWhatsappRow): string | undefined {
  return readStringField(
    row,
    "media_filename",
    "mediaFilename",
    "filename",
    "file_name",
    "fileName",
    "document_filename",
    "documentFilename"
  );
}

function readMediaBucket(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "media_bucket", "mediaBucket", "bucket");
}

/** Columna `wamid`: id de Meta del mensaje. `undefined` en filas históricas. */
function readWamid(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "wamid", "waMid", "meta_wamid");
}

/**
 * Columna `message_translated`: texto exacto que salió al huésped cuando el
 * engine tradujo la respuesta. Devuelve el string TAL CUAL (sin recortar), que
 * es lo que de verdad recibió: solo se descartan el null y el string vacío.
 *
 * Si coincide con el `message` de la fila se trata como "no hubo traducción":
 * el contrato es que `null` marca ese caso, pero una copia idéntica no aporta
 * nada que mostrar y no debe pintar el chip.
 */
function readTranslatedMessage(row: WubbyWhatsappRow): string | undefined {
  const v = getRowField(row, "message_translated", "messageTranslated");
  if (typeof v !== "string") return undefined;
  if (v.trim().length === 0) return undefined;
  const original = typeof row.message === "string" ? row.message : "";
  if (v.trim() === original.trim()) return undefined;
  return v;
}

/**
 * Columna `inbound_translation`: traducción al español de lo que escribió el
 * huésped, que el engine estampa 1-2 s DESPUÉS del insert de la fila. Mismo
 * criterio que `readTranslatedMessage`: se descartan null, vacío y la copia
 * idéntica a `message` (traducir de español a español no aporta nada que
 * mostrar y no debe pintar la marca).
 */
function readInboundTranslation(row: WubbyWhatsappRow): string | undefined {
  const v = getRowField(row, "inbound_translation", "inboundTranslation");
  if (typeof v !== "string") return undefined;
  if (v.trim().length === 0) return undefined;
  const original = typeof row.message === "string" ? row.message : "";
  if (v.trim() === original.trim()) return undefined;
  return v;
}

/** Columna `inbound_detected_lang`: ISO 639-1 del entrante; `undefined` = español o sin dato. */
function readInboundDetectedLang(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "inbound_detected_lang", "inboundDetectedLang");
}

/** Columna `reaction_to_wamid`: solo filas de reacción; wamid del mensaje reaccionado. */
function readReactionToWamid(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "reaction_to_wamid", "reactionToWamid");
}

function readMetaMediaId(row: WubbyWhatsappRow): string | undefined {
  return readStringField(row, "media_meta_id", "mediaMetaId", "meta_media_id", "metaMediaId", "media_id", "Media_Id");
}

function readMessageType(row: WubbyWhatsappRow, format?: string): string | undefined {
  return readStringField(row, "message_type", "messageType", "Message_Type", "Message Type") ?? format;
}

function mediaUrlLooksLikeImage(url: string): boolean {
  const withoutQuery = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/.test(withoutQuery);
}

export type MediaKind = "image" | "video" | "audio" | "pdf" | "document" | "file";

/** Pistas de mime para documentos office/texto que NO son pdf. */
const DOCUMENT_MIME_HINTS = [
  "msword", "wordprocessingml",           // .doc .docx
  "ms-excel", "spreadsheetml",            // .xls .xlsx
  "ms-powerpoint", "presentationml",      // .ppt .pptx
  "opendocument", "rtf",                  // .odt/.ods, .rtf
  "text/plain", "text/csv",               // .txt .csv
];

/** Categoría de render a partir del mime (fuente de verdad; `format` upstream no es fiable). */
export function resolveMediaKind(mime: string | null | undefined): MediaKind {
  const m = mime?.trim().toLowerCase() ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (DOCUMENT_MIME_HINTS.some((h) => m.includes(h))) return "document";
  return "file";
}

function readMessageMedia(row: WubbyWhatsappRow): {
  messageType: string;
  mediaUrl: string | null;
  mediaStoragePath: string | null;
  mediaMimeType: string | null;
  mediaCaption: string | null;
  mediaFilename: string | null;
  mediaBucket: string | null;
  metaMediaId: string | null;
} {
  const fmt = readMessageFormat(row);
  const declaredType = readMessageType(row, fmt);
  const mediaUrl = readMediaUrl(row) ?? null;
  const mediaStoragePath = readMediaStoragePath(row) ?? null;
  const mediaMimeType = readMediaMimeType(row) ?? null;
  const mediaCaption = readMediaCaption(row) ?? null;
  const mediaFilename = readMediaFilename(row) ?? null;
  const mediaBucket = readMediaBucket(row) ?? null;
  const metaMediaId = readMetaMediaId(row) ?? null;
  const normalizedType = declaredType?.trim().toLowerCase();
  const isImageByType = normalizedType === "image";
  const isDocumentByType = normalizedType === "document" || normalizedType === "file";
  const isImageByUrl = mediaUrl ? mediaUrlLooksLikeImage(mediaUrl) : false;

  // El mime manda. El upstream (n8n) escribe `format="image"` para casi todo,
  // así que solo confiamos en `format`/type cuando no hay mime.
  const kind: MediaKind | null = mediaMimeType
    ? resolveMediaKind(mediaMimeType)
    : isDocumentByType
    ? "document"
    : isImageByType || Boolean(mediaStoragePath) || isImageByUrl
    ? "image"
    : null;
  const messageType = kind === "pdf" ? "document" : kind ?? declaredType ?? "text";

  return { messageType, mediaUrl, mediaStoragePath, mediaMimeType, mediaCaption, mediaFilename, mediaBucket, metaMediaId };
}

/**
 * `true` cuando el mensaje DICE ser media (hay mime o filename) pero no existe
 * archivo del que tirar: `media_storage_path` y `media_url` vienen ambos vacíos.
 *
 * Es un estado esperado, no un error de datos: el engine escribe la fila del
 * mensaje aunque la subida a Storage no ocurra (el adjunto superó el tope de
 * 20 MB, o el upload falló). El mensaje existe, el archivo no, así que no hay
 * nada que firmar ni que abrir.
 *
 * Sin las DOS señales (mime y filename) es texto puro y devuelve `false`.
 */
export function isMediaWithoutFile(m: {
  mediaStoragePath?: string | null;
  mediaUrl?: string | null;
  mediaMimeType?: string | null;
  mediaFilename?: string | null;
}): boolean {
  if (m.mediaStoragePath || m.mediaUrl) return false;
  return Boolean(m.mediaMimeType || m.mediaFilename);
}

/**
 * Cuerpo y preview de un mensaje a partir de su fila. Único sitio donde vive la
 * cascada `message` → `media_caption` → emoji por mime, para que el preview de
 * la lista y el de la burbuja no puedan divergir.
 */
function resolveMessageBodyAndPreview(row: WubbyWhatsappRow): {
  body: string;
  previewRaw: string;
  media: ReturnType<typeof readMessageMedia>;
} {
  const media = readMessageMedia(row);
  const messageRaw = String(row.message ?? "").trim();
  const isImage = media.messageType.trim().toLowerCase() === "image";
  const hasMedia = Boolean(media.mediaStoragePath || media.mediaUrl);
  // El archivo que no se pudo procesar tampoco es un mensaje "(vacío)": la
  // burbuja pinta su propia tarjeta y el preview lo dice con todas las letras.
  const missingFile = isMediaWithoutFile(media);
  const body = messageRaw || media.mediaCaption || (hasMedia || missingFile ? "" : "(vacío)");
  const kind = resolveMediaKind(media.mediaMimeType);
  // La lista de conversaciones se lee TODA en español: si el entrante venía en
  // otro idioma, el preview muestra la traducción y no el original. `body`
  // sigue siendo lo que escribió el huésped; acá solo cambia lo que se ve en la
  // bandeja. En filas viejas o sin traducir la columna no existe y todo queda
  // exactamente igual que antes.
  const previewRaw =
    readInboundTranslation(row) ||
    body ||
    (missingFile
      ? "📎 Archivo no disponible"
      : kind === "pdf" || kind === "document"
      ? `📎 ${media.mediaFilename ?? "Documento"}`
      : kind === "video"
      ? "🎥 Video"
      : kind === "audio"
      ? "🎙️ Audio"
      : isImage
      ? "📷 Imagen"
      : media.mediaStoragePath
      ? "📎 Archivo"
      : "—");

  return { body, previewRaw, media };
}

/**
 * Preview + etiqueta de hora de la lista, sin construir el `Message` completo.
 * La bandeja no necesita remitente ni media, así que la fila puede venir con
 * solo `WUBBY_PREVIEW_COLUMNS`.
 */
export function buildConversationPreviewFromRow(row: WubbyWhatsappRow): {
  previewRaw: string;
  lastMessageLabel: string;
  createdAtIso: string;
} {
  return {
    previewRaw: resolveMessageBodyAndPreview(row).previewRaw,
    lastMessageLabel: formatMessageDisplayListTime(row as Record<string, unknown>),
    createdAtIso: typeof row.created_at === "string" ? row.created_at : String(row.created_at ?? ""),
  };
}

/** Columna `cause_request` (`yes` = disparó handoff a humano). */
export function readCauseRequest(row: WubbyWhatsappRow): string | undefined {
  const v = getRowField(row, "cause_request", "Cause_Request", "causeRequest");
  if (v == null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Misma regla para badge “Solicitó agente humano”, banner y notificación de escritorio.
 * Acepta fila Supabase o `Message` (campos en camelCase).
 */
export function messageNeedsHumanAlert(messageOrRow: Record<string, unknown>): boolean {
  const raw =
    messageOrRow["cause_request"] ??
    messageOrRow["Cause_Request"] ??
    messageOrRow["causeRequest"] ??
    messageOrRow["request"] ??
    messageOrRow["requires_human"] ??
    messageOrRow["requiresHuman"] ??
    messageOrRow["needs_human"] ??
    messageOrRow["needsHuman"];

  const normalized = String(raw ?? "").trim().toLowerCase();

  return (
    raw === true ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "si" ||
    normalized === "sí"
  );
}

export function toBool(v: unknown, defaultVal = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return ["true", "1", "yes", "si", "sí", "t"].includes(t);
  }
  return defaultVal;
}

/**
 * Clasificación de mensaje para la burbuja.
 * - Sender = línea hotel → saliente (IA/agente por defecto).
 * - Recipient = línea hotel y sender no es hotel → entrante huésped.
 * Columnas opcionales (`message_author`, `sender_role`, `from_ai`, …) tienen prioridad cuando existen.
 */
export function classifyMessageSender(
  row: WubbyWhatsappRow,
  guestNorm: string,
  hotelIdentities: Set<string>
): MessageSender {
  const s = normalizeWaIdentity(row.sender ?? "");
  const r = normalizeWaIdentity(row.recipient ?? "");
  const senderRaw = String(row.sender ?? "").trim();

  if (isHumanAnswerSender(senderRaw)) {
    return "agent";
  }

  if (guestNorm && s === guestNorm) return "user";

  const originRaw = getRowField(row, "origin");
  if (typeof originRaw === "string") {
    const o = originRaw.trim().toLowerCase();
    if (o === "human") return "agent";
    if (o === "ai") return "ai";
    if (o === "client" || o === "guest" || o === "user") return "user";
  }

  const explicit =
    getRowField(row, "message_author", "sender_role", "Sender Role", "role", "tipo", "author") ??
    getRowField(row, "from_ai", "fromAI");
  if (typeof explicit === "string") {
    const e = explicit.toLowerCase();
    if (/human|agent|staff|person|recepci|operad/i.test(e)) return "agent";
    if (/ai|bot|assistant|automat/i.test(e)) return "ai";
  }
  if (toBool(explicit, false) === false && getRowField(row, "from_ai") != null) {
    return toBool(getRowField(row, "from_ai"), true) ? "ai" : "agent";
  }

  const senderLower = String(row.sender ?? "").toLowerCase();
  if (senderLower.includes("agent") || senderLower.includes("human")) return "agent";

  const directionRaw = getRowField(row, "direction", "Direction");
  if (typeof directionRaw === "string") {
    const d = directionRaw.trim().toLowerCase();
    if (d === "inbound" || d === "incoming") return "user";
    if (d === "outbound" || d === "outgoing") return "ai";
  }

  const senderTypeRaw = getRowField(row, "sender_type", "senderType", "Sender_Type");
  if (typeof senderTypeRaw === "string") {
    const st = senderTypeRaw.trim().toLowerCase();
    if (/guest|visitor|customer|^user$/i.test(st)) return "user";
    if (/human|^agent$|staff|employee/i.test(st)) return "agent";
    if (/ai|assistant|bot|^business$/i.test(st)) return "ai";
  }

  if (s && hotelIdentities.has(s)) {
    return "ai";
  }
  if (r && hotelIdentities.has(r) && (!s || !hotelIdentities.has(s))) {
    return "user";
  }

  return "ai";
}

/**
 * Día calendario EN BOGOTÁ (`YYYY-MM-DD`) de un instante.
 *
 * "Hoy" y "Ayer" se decidían con `getFullYear/getMonth/getDate`, que responden
 * en la zona del navegador: fuera de Colombia el mismo mensaje cambiaba de día
 * y la lista decía "Ayer" donde en recepción decía la hora.
 */
function colombiaDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COLOMBIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatMessageListTime(iso: string, locale = "es"): string {
  const d = parseWhatsappInstant(iso);
  if (!d) return "—";

  const now = new Date();
  const day = colombiaDayKey(d);
  if (day === colombiaDayKey(now)) {
    return new Intl.DateTimeFormat(locale, {
      timeZone: COLOMBIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  if (day === colombiaDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) {
    return "Ayer";
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: COLOMBIA_TIME_ZONE,
    day: "numeric",
    month: "short",
  }).format(d);
}

export function formatMessageDetailTime(iso: string, locale = "es"): string {
  const d = parseWhatsappInstant(iso);
  if (!d) return "—";
  return new Intl.DateTimeFormat(locale, {
    timeZone: COLOMBIA_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function isMediaMessage(message: Record<string, unknown>): boolean {
  const type = String(
    message.whatsapp_type ??
      message.message_type ??
      message.messageType ??
      message.type ??
      message.media_type ??
      ""
  )
    .trim()
    .toLowerCase();

  return (
    type === "image" ||
    type === "document" ||
    type === "pdf" ||
    Boolean(message.media_url) ||
    Boolean(message.mediaUrl) ||
    Boolean(message.media_storage_path) ||
    Boolean(message.mediaStoragePath) ||
    Boolean(message.media_type) ||
    Boolean(message.media_mime_type) ||
    Boolean(message.mediaMimeType) ||
    Boolean(message.media_filename) ||
    Boolean(message.mediaFilename)
  );
}

export function getMessageDisplayDate(message: Record<string, unknown>): Date {
  const raw =
    message.created_at ??
    message.createdAt ??
    message.sentAtIso;

  // `created_at` de Wubby es naive en hora Bogotá: se interpreta explícitamente
  // ahí, nunca en la zona del navegador.
  return parseWhatsappInstant(typeof raw === "string" ? raw : String(raw ?? "")) ?? new Date(0);
}

export function getMessageDisplayMs(message: Record<string, unknown>): number {
  return getMessageDisplayDate(message).getTime();
}

export function formatMessageDisplayTime(message: Record<string, unknown>, locale = "es-CO"): string {
  const date = getMessageDisplayDate(message);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(locale, {
    timeZone: COLOMBIA_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatMessageDisplayListTime(message: Record<string, unknown>, locale = "es"): string {
  const d = getMessageDisplayDate(message);
  if (Number.isNaN(d.getTime())) return "—";

  const now = new Date();
  const day = colombiaDayKey(d);
  if (day === colombiaDayKey(now)) {
    return new Intl.DateTimeFormat(locale, {
      timeZone: COLOMBIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  if (day === colombiaDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) {
    return "Ayer";
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: COLOMBIA_TIME_ZONE,
    day: "numeric",
    month: "short",
  }).format(d);
}

export function getConversationDisplayActivityMs(conversation: Pick<Conversation, "messages" | "lastActivityIso">): number {
  const lastMessage = conversation.messages.at(-1);
  if (lastMessage) {
    return getMessageDisplayMs(lastMessage as unknown as Record<string, unknown>);
  }
  return parseWhatsappInstantMs(conversation.lastActivityIso) ?? 0;
}

export function displayGuestName(guestName: string | null | undefined, guestPhone: string): string {
  const n = typeof guestName === "string" ? guestName.trim() : "";
  if (n.length > 0) return n;
  return guestPhone || "—";
}

function readBoolCol(v: boolean | null | undefined, defaultVal: boolean): boolean {
  if (v === null || v === undefined) return defaultVal;
  return v;
}

function readUnreadCount(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Ventana en la que una reactivación automática sigue siendo una novedad. */
export const AUTO_REACTIVATION_NOTICE_MS = 24 * 60 * 60 * 1000;

/**
 * Fecha de la última reactivación AUTOMÁTICA de la IA, o null si la última la
 * hizo una persona (o si nunca hubo, o si ya pasó la ventana de aviso).
 *
 * El origen lo escribe quien reactiva: el barrido del engine pone "auto", el
 * botón del inbox pone "manual". No se deduce de otra cosa.
 *
 * El corte por antigüedad se resuelve ACÁ y no al pintar: leer el reloj durante
 * el render es impuro (lo prohíbe react-hooks/purity) y además haría que el
 * mismo dato se viera distinto en servidor y en cliente.
 */
export function readAutoReactivatedAt(row: ConversationDbRow, now: number = Date.now()): string | null {
  if (row.ai_reactivation_source !== "auto" || !row.ai_reactivated_at) return null;

  const parsed = Date.parse(row.ai_reactivated_at);
  if (Number.isNaN(parsed) || now - parsed > AUTO_REACTIVATION_NOTICE_MS) return null;
  return row.ai_reactivated_at;
}

/**
 * Fecha en que el triage del engine escaló esta conversación, SOLO si sigue sin
 * atender. `null` en cualquier otro caso.
 *
 * `ai_triage_at` es una marca histórica: el engine la estampa al escalar y no la
 * limpia nunca (le sirve de anti-loop por 24 h y de tope de escalamientos). Por
 * eso sola no alcanza —una conversación escalada la semana pasada y resuelta
 * seguiría teniendo fecha—, y hay que cruzarla con el estado actual:
 *
 * - `needs_human` en false: alguien la resolvió o la IA volvió a hacerse cargo.
 * - `status = "human_control"`: alguien ya la tomó. OJO, este es el caso que
 *   obliga a mirar `status` y no solo `needs_human`: tanto el PATCH
 *   `human_control` como responder o mandar un archivo dejan `needs_human` en
 *   TRUE a propósito. Sin este corte, el distintivo seguiría gritando "sin
 *   atender" en una conversación que la recepcionista acaba de tomar.
 * - `status = "completed"`: al cerrar no se tocan `needs_human` ni `ai_active`,
 *   así que una conversación cerrada puede quedar con ambas marcas puestas.
 *
 * A diferencia de `readAutoReactivatedAt` NO caduca por tiempo: "volvió sola" es
 * una novedad que envejece, esto es un pendiente que sigue pendiente hasta que
 * alguien haga algo. Que se apague solo a las 24 h es justo lo que ya pasa hoy.
 */
export function readTriageEscalatedAt(row: ConversationDbRow): string | null {
  if (!row.ai_triage_at) return null;
  if (!readBoolCol(row.needs_human, false)) return null;

  const st = String(row.status ?? "").toLowerCase();
  if (st === "human_control" || st === "completed") return null;

  return Number.isNaN(Date.parse(row.ai_triage_at)) ? null : row.ai_triage_at;
}

/**
 * Estado operativo y modo control a partir de la tabla `conversations`.
 */
export function mapOperationalFromConversationRow(row: ConversationDbRow): {
  operationalStatus: OperationalStatus;
  controlMode: ControlMode;
} {
  const st = String(row.status ?? "").toLowerCase();
  const needsHuman = readBoolCol(row.needs_human, false);
  const aiActive = readBoolCol(row.ai_active, true);
  const blocked = readBoolCol(row.blocked, false);

  if (st === "completed") {
    return { operationalStatus: "closed", controlMode: "human" };
  }
  if (blocked) {
    return { operationalStatus: "requires_attention", controlMode: aiActive ? "ai" : "human" };
  }
  if (st === "human_control") {
    return { operationalStatus: "requires_attention", controlMode: "human" };
  }
  if (needsHuman) {
    return { operationalStatus: "requires_attention", controlMode: "human" };
  }
  if (!aiActive) {
    return { operationalStatus: "requires_attention", controlMode: "human" };
  }
  return { operationalStatus: "ai_active", controlMode: "ai" };
}

function emptyReservation() {
  return {
    confirmationCode: "—",
    checkIn: "—",
    checkOut: "—",
    adults: 0,
    children: 0,
    roomType: "—",
    bookingStatus: "—",
  };
}

/**
 * Bandeja: metadatos desde `conversations`, historial desde `Wubby_Whatsapp`.
 * Orden de `convRows` se respeta (p. ej. `updated_at` desc desde la API).
 */
export function mergeConversationsTableWithMessages(
  convRows: ConversationDbRow[],
  msgRows: WubbyWhatsappRow[],
  options: { hotelWhatsappById: HotelWhatsappByIdMap; messageLimit?: number }
): Conversation[] {
  if (convRows.length === 0) return [];

  // Decorate-sort-undecorate: `getMessageDisplayMs` construye un `Date` por
  // llamada y dentro del comparador se ejecutaba ~2·N·log₂(N) veces (≈300k
  // objetos temporales para 11,5k filas). Precalculado son N.
  const decorated = msgRows.map((row) => ({
    row,
    ms: getMessageDisplayMs(row as Record<string, unknown>),
  }));
  decorated.sort((a, b) => a.ms - b.ms);
  const sortedMsgs = decorated.map((d) => d.row);

  const messageLimit = options.messageLimit ?? MESSAGES_LIMIT;
  const messagesByPhone = new Map<string, WubbyWhatsappRow[]>();
  for (const row of sortedMsgs) {
    const rowHotelIdentities = resolveHotelWaIdentitiesForRow(row, options.hotelWhatsappById);
    const g = inferGuestPhone(row, rowHotelIdentities);
    if (!g || g === "unknown") continue;
    let list = messagesByPhone.get(g);
    if (!list) {
      list = [];
      messagesByPhone.set(g, list);
    }
    list.push(row);
  }

  // Un único recorte por teléfono al terminar. Antes se hacía `slice(-limit)`
  // en CADA fila procesada, creando un array nuevo por mensaje (≈1,2M slots de
  // array desechados por petición en el hotel más grande).
  for (const [phone, list] of messagesByPhone) {
    if (list.length > messageLimit) {
      messagesByPhone.set(phone, list.slice(-messageLimit));
    }
  }

  const out: Conversation[] = [];

  for (const cr of convRows) {
    // Misma clave que `inferGuestPhone` usó para agrupar: si acá se normalizara
    // a dígitos un LID, el `get` fallaría y la conversación saldría sin hilo.
    const guestKey = normalizeGuestIdentityKey(cr.guest_phone ?? "");
    const guestPhone = normalizeWaIdentity(cr.guest_phone ?? "");
    const msgList = guestKey ? messagesByPhone.get(guestKey) ?? [] : [];

    const lastRow = msgList.length > 0 ? msgList[msgList.length - 1]! : null;
    const lastMessage = lastRow
      ? buildMessageFromWubbyRow(
          lastRow,
          guestPhone,
          resolveHotelWaIdentitiesForRow(lastRow, options.hotelWhatsappById)
        )
      : null;

    const messages: Message[] = msgList.map(
      (msgRow) =>
        buildMessageFromWubbyRow(
          msgRow,
          guestPhone,
          resolveHotelWaIdentitiesForRow(msgRow, options.hotelWhatsappById)
        ).message
    );

    out.push(
      buildConversationFromRow(cr, {
        lastPreview: lastMessage ? lastMessage.previewRaw : "Sin mensajes",
        lastMessageAt: lastMessage ? lastMessage.lastMessageLabel : "—",
        lastActivityIso: lastRow ? lastRow.created_at : cr.created_at || cr.updated_at,
        messages,
      })
    );
  }

  return out;
}

/**
 * Único constructor de `Conversation`. Todo lo que no depende del hilo sale de
 * la fila de `conversations`; lo que sí depende llega por `parts`. Lo comparten
 * el merge con historial (reservas) y la bandeja sin historial.
 */
function buildConversationFromRow(
  cr: ConversationDbRow,
  parts: {
    lastPreview: string;
    lastMessageAt: string;
    lastActivityIso: string;
    messages: Message[];
  }
): Conversation {
  // `normalizeWaIdentity` devuelve el LID crudo cuando no es un teléfono, así
  // que acá nunca se arma un `+CO.28322187600722863`.
  const guestPhone = normalizeWaIdentity(cr.guest_phone ?? "");
  const phoneDisplay = guestPhone || String(cr.guest_phone ?? "").trim() || "—";

  const channel = normalizeChannel(cr.channel);
  const isOta = isOtaChannel(channel);

  const { operationalStatus, controlMode } = mapOperationalFromConversationRow(cr);
  const cotizacion =
    cr.cotizacion != null && String(cr.cotizacion).trim() !== "" ? String(cr.cotizacion) : null;

  const guest = {
    id: cr.id,
    // En OTA el respaldo NUNCA puede ser `phoneDisplay`: `guest_phone` guarda el
    // UUID del hilo de Channex y, al no tener puntos, `normalizeWaIdentity` no
    // lo reconoce como LID, le arranca los guiones y devuelve un número que
    // parece un celular colombiano (`+5751834421987712503`). El engine ya manda
    // "Huésped de Booking.com" cuando la OTA no reveló el nombre, así que este
    // respaldo casi nunca corre; existe para que, si algún día llega vacío,
    // recepción vea el canal y no un teléfono inventado.
    name: displayGuestName(cr.guest_name, isOta ? channelLabel(channel) : phoneDisplay),
    phone: phoneDisplay,
    property: cotizacion ? cotizacion : "Sin propiedad indicada",
    language: "—",
    internalNotes: readBoolCol(cr.blocked, false)
      ? cr.blocked_at
        ? `Bloqueado · ${cr.blocked_at}`
        : "Bloqueado"
      : "Sin notas internas en Supabase.",
    tags: cotizacion ? [cotizacion.slice(0, 24)] : [],
    profileCompleteness: cotizacion ? 35 : 15,
    reservation: emptyReservation(),
  };

  const requestRaw = typeof cr.request === "string" ? cr.request.trim() : cr.request;
  const requestValue =
    typeof requestRaw === "string" && requestRaw.length > 0 ? requestRaw : null;

  return {
    id: cr.id,
    guest,
    guestPhone: phoneDisplay,
    needsHuman: readBoolCol(cr.needs_human, false),
    aiActive: readBoolCol(cr.ai_active, true),
    dbStatus: cr.status,
    autoReactivatedAt: readAutoReactivatedAt(cr),
    triageEscalatedAt: readTriageEscalatedAt(cr),
    blocked: readBoolCol(cr.blocked, false),
    blockedAt: cr.blocked_at,
    request: requestValue,
    lastMessagePreview: truncateListPreview(parts.lastPreview),
    lastMessageAt: parts.lastMessageAt,
    lastActivityIso: parts.lastActivityIso,
    unreadCount: readUnreadCount(cr.unread_count),
    guestPhoneRaw: String(cr.guest_phone ?? "").trim(),
    lastGuestMessageAt: cr.last_guest_message_at ?? null,
    operationalStatus,
    controlMode,
    channel,
    channelLabel: channelLabel(channel),
    messages: parts.messages,
    // El servidor nunca marca un hilo como autoritativo. En la bandeja
    // `messages` va directamente vacío; el hilo lo carga
    // GET /api/inbox/messages y es el cliente quien pone `true`.
    messagesLoaded: false,
  };
}

/**
 * Bandeja: una `Conversation` por fila de `conversations`, con `messages: []`.
 *
 * El preview sale del último mensaje que la propia query ya resolvió (embedding
 * PostgREST con `limit 1` por conversación), no de barrer el histórico.
 * `lastActivityIso` se alimenta del `created_at` de ese mensaje para que el
 * orden de la lista sea idéntico al que producía el merge con historial; solo
 * cae a la fila de `conversations` cuando no hay ningún mensaje.
 */
export function buildInboxConversations(
  convRows: ConversationDbRow[],
  lastMessageByConversationId: Map<string, WubbyWhatsappRow>
): Conversation[] {
  const out: Conversation[] = [];

  for (const cr of convRows) {
    const lastRow = lastMessageByConversationId.get(String(cr.id));
    const preview = lastRow ? buildConversationPreviewFromRow(lastRow) : null;

    out.push(
      buildConversationFromRow(cr, {
        lastPreview: preview ? preview.previewRaw : "Sin mensajes",
        lastMessageAt: preview ? preview.lastMessageLabel : "—",
        lastActivityIso: preview ? preview.createdAtIso : cr.created_at || cr.updated_at,
        messages: [],
      })
    );
  }

  return out;
}

/** Expone semilla estable para avatares. */
export function guestSeed(guestPhone: string): string {
  return guestPhone;
}

/**
 * Dado un row de `Wubby_Whatsapp` y el teléfono del huésped (conversación destino),
 * deriva el `Message` para Realtime / UI incremental.
 *
 * `hotelIdentities` debe ser el set del whatsapp_number del hotel de la fila
 * (vía `resolveHotelWaIdentitiesForRow` + mapa `hotel_id → whatsapp_number`).
 */
export function buildMessageFromWubbyRow(
  row: WubbyWhatsappRow,
  guestPhone: string,
  hotelIdentities: Set<string>
): {
  message: Message;
  previewRaw: string;
  createdAtIso: string;
  lastMessageLabel: string;
} {
  const guestNorm = normalizeWaIdentity(guestPhone);
  const sender = classifyMessageSender(row, guestNorm, hotelIdentities);

  const fmt = readMessageFormat(row);
  const { body, previewRaw, media } = resolveMessageBodyAndPreview(row);
  const {
    messageType,
    mediaUrl,
    mediaStoragePath,
    mediaMimeType,
    mediaCaption,
    mediaFilename,
    mediaBucket,
    metaMediaId,
  } = media;
  const causeReqHandoff = readCauseRequest(row);
  const translatedBody = readTranslatedMessage(row);
  // Traducción del entrante: solo tiene sentido en la burbuja del huésped. Si
  // el remitente no es él, la columna se ignora aunque venga poblada, para no
  // atribuirle a la casa un texto que nunca escribió.
  const inboundTranslation = sender === "user" ? readInboundTranslation(row) : undefined;
  // El idioma detectado se lee AUNQUE no haya traducción: es lo que decide el
  // default del selector del composer, y sirve igual si el engine detectó
  // inglés pero no llegó a traducir. La marca de la burbuja sí exige la
  // traducción, así que esto no pinta nada de más.
  const inboundDetectedLang = sender === "user" ? readInboundDetectedLang(row) : undefined;
  const clientTempIdRaw = readStringField(row, "client_temp_id", "clientTempId");
  const clientTempId = clientTempIdRaw?.trim() || undefined;

  return {
    message: {
      id: String(row.id),
      body,
      sentAt: formatMessageDisplayTime(row as Record<string, unknown>),
      sentAtIso: typeof row.created_at === "string" ? row.created_at : String(row.created_at ?? ""),
      sender,
      ...(clientTempId ? { clientTempId, status: "confirmed" as const } : {}),
      ...(fmt ? { format: fmt } : {}),
      messageType,
      mediaUrl,
      mediaStoragePath,
      mediaMimeType,
      mediaCaption,
      mediaFilename,
      mediaBucket,
      metaMediaId,
      wamid: readWamid(row) ?? null,
      reactionToWamid: readReactionToWamid(row) ?? null,
      ...(causeReqHandoff ? { causeRequest: causeReqHandoff } : {}),
      // Solo se adjunta cuando hubo traducción real; sin la columna (filas
      // viejas, hoteles sin multiidioma) la burbuja queda exactamente igual.
      ...(translatedBody ? { translatedBody } : {}),
      // El insert llega sin traducción y el UPDATE del engine la agrega 1-2 s
      // después: `handleWubbyUpdate` reconstruye el mensaje con esta misma
      // función, así que la burbuja se repinta sola cuando aparece.
      ...(inboundTranslation ? { inboundTranslation } : {}),
      ...(inboundDetectedLang ? { inboundDetectedLang } : {}),
    },
    previewRaw,
    createdAtIso: row.created_at,
    lastMessageLabel: formatMessageDisplayListTime(row as Record<string, unknown>),
  };
}

/** Devuelve la conversación cuyo `guestPhone` matchea el `sender` o `recipient` del row. */
export function findConversationForWubbyRow(
  conversations: Conversation[],
  row: WubbyWhatsappRow
): Conversation | null {
  const s = normalizePhoneDigits(row.sender ?? "");
  const r = normalizePhoneDigits(row.recipient ?? "");
  if (!s && !r) return null;
  for (const c of conversations) {
    const cp = normalizePhoneDigits(c.guestPhone);
    if (!cp) continue;
    if (cp === s || cp === r) return c;
  }
  return null;
}

/**
 * Aplica un patch incremental sobre una conversación existente a partir de un row
 * actualizado de `conversations`. Preserva mensajes ya cargados.
 */
export function applyConversationRowPatch(
  existing: Conversation,
  row: ConversationDbRow
): Conversation {
  const { operationalStatus, controlMode } = mapOperationalFromConversationRow(row);
  const requestRaw = typeof row.request === "string" ? row.request.trim() : row.request;
  const requestValue =
    typeof requestRaw === "string" && requestRaw.length > 0 ? requestRaw : null;

  const normalizedPhone = normalizeWaIdentity(row.guest_phone ?? "");
  const phoneDisplay =
    normalizedPhone || String(row.guest_phone ?? "").trim() || existing.guestPhone;

  const patchedChannel = normalizeChannel(row.channel);
  // Mismo respaldo que en `buildConversationFromRow`: en OTA, `guest_phone` es
  // el UUID del hilo de Channex y usarlo como nombre pinta un teléfono
  // inventado. Los dos caminos tienen que coincidir o el nombre cambiaría solo
  // al llegar un UPDATE por Realtime.
  const name = displayGuestName(
    row.guest_name,
    isOtaChannel(patchedChannel) ? channelLabel(patchedChannel) : phoneDisplay
  );

  const cotizacion =
    row.cotizacion != null && String(row.cotizacion).trim() !== ""
      ? String(row.cotizacion)
      : null;

  return {
    ...existing,
    guest: {
      ...existing.guest,
      id: row.id,
      name,
      phone: phoneDisplay,
      property: cotizacion ? cotizacion : existing.guest.property,
      tags: cotizacion ? [cotizacion.slice(0, 24)] : existing.guest.tags,
    },
    guestPhone: phoneDisplay,
    // Mismo respaldo que `phoneDisplay`: si la fila del UPDATE llegara sin
    // `guest_phone`, se conserva el que ya teníamos en vez de dejar vacío el
    // identificador con el que se le habla al engine.
    guestPhoneRaw: String(row.guest_phone ?? "").trim() || existing.guestPhoneRaw,
    needsHuman: row.needs_human ?? false,
    aiActive: row.ai_active ?? true,
    dbStatus: row.status,
    // Por Realtime es como llega el aviso de que la IA volvió sola: el barrido
    // del engine actualiza la fila y la bandeja lo refleja sin refetch.
    autoReactivatedAt: readAutoReactivatedAt(row),
    // Mismo camino para el escalamiento del triage: el engine estampa
    // `ai_triage_at` y la fila viaja por Realtime, así que el distintivo
    // aparece sin refetch. Y como el corte mira `needs_human` y `status`,
    // tomar la conversación o cerrarla lo apaga por el mismo canal.
    triageEscalatedAt: readTriageEscalatedAt(row),
    blocked: row.blocked ?? false,
    blockedAt: row.blocked_at,
    // El trigger que mantiene `last_guest_message_at` dispara un UPDATE en
    // `conversations`, así que este es el camino por el que el composer se
    // desbloquea en vivo cuando el huésped escribe. Sin propagarlo, con la
    // bandeja ya sin `messages`, se quedaría bloqueado hasta el próximo refetch.
    lastGuestMessageAt: row.last_guest_message_at ?? null,
    request: requestValue,
    unreadCount: readUnreadCount(row.unread_count),
    operationalStatus,
    controlMode,
    // Se recalcula aunque hoy el canal no cambie después de creada la
    // conversación. Este merge es el ÚNICO punto que recibe una fila fresca de
    // la base sin reconstruir la conversación entera, así que un campo que no
    // se copie acá queda congelado con el valor que tenía en memoria. Dejarlo
    // afuera "porque no cambia" es exactamente cómo se cuela un dato viejo el
    // día que sí cambie.
    channel: patchedChannel,
    channelLabel: channelLabel(patchedChannel),
  };
}
