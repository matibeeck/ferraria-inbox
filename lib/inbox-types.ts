import type { MessageChannel } from "@/lib/channels";
import type { InboxTicketBadge } from "@/lib/inbox-ticket-badges";

/** Estado de la conversación en la operación (cola de recepción + IA). */
export type OperationalStatus = "ai_active" | "requires_attention" | "closed";

export type ControlMode = "ai" | "human";

export type MessageSender = "user" | "ai" | "agent";

/**
 * Entrega del mensaje saliente DENTRO DE ESTE INBOX: `pending` mientras la
 * petición de envío está en vuelo, `confirmed` cuando la fila ya existe en la
 * base, `failed` cuando sabemos que NO existe.
 *
 * OJO: `confirmed` significa "quedó guardado", NO "le llegó al huésped". La
 * entrega real solo la sabe Meta y vive en `MessageDeliveryReceipt`.
 *
 * `failed` solo se pinta con evidencia: o el engine garantizó que no envió, o
 * preguntamos por `client_temp_id` y la fila no está. Nunca por vencimiento de
 * un temporizador ni por un error del que no sepamos el desenlace — decirle
 * "No se envió" a la recepcionista sin saberlo la empuja a reenviar, y eso le
 * duplica el mensaje al huésped.
 */
export type MessageDeliveryStatus = "pending" | "confirmed" | "failed";

/** Estados de entrega que reporta Meta por webhook, de menos a más avanzado. */
export type MetaDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/**
 * Acuse de Meta sobre un mensaje saliente, tal y como lo sirven
 * `GET /api/inbox/messages` (en `statuses`, por página del hilo) y el refresco
 * `GET /api/conversations/[id]/message-statuses?wamids=…`.
 *
 * La fuente es `message_statuses` (service-role only), y se cruza con la
 * burbuja por `wamid`.
 *
 * Que NO exista acuse para una burbuja es el caso NORMAL, no una anomalía: a
 * agosto de 2026 solo ~7 % de los salientes tiene `wamid`. El resto son filas
 * históricas y los hoteles que todavía envían por n8n, que nunca van a tener
 * acuse. Por eso "sin acuse" se pinta como ✓ ("salió"), jamás como pendiente:
 * un reloj eterno sobre una conversación cerrada hace meses miente igual que el
 * ✓✓ que se pintaba antes, solo que asustando.
 */
export interface MessageDeliveryReceipt {
  wamid: string;
  status: MetaDeliveryStatus;
  /** Código de error de Meta, p. ej. 131026 (Message Undeliverable). */
  errorCode: number | null;
  /** Título legible del error de Meta; puede venir vacío. */
  errorTitle: string | null;
}

export interface AiMessageMeta {
  latencyMs: number;
  tokens: number;
}

/** Reserva PMS: solo se muestra si hay datos reales o derivados. */
export interface ReservationDetails {
  confirmationCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomType: string;
  bookingStatus: string;
}

export interface Guest {
  id: string;
  name: string;
  phone: string;
  property: string;
  language: string;
  internalNotes: string;
  tags: string[];
  /** 0–100; sin datos de Supabase será bajo o 0 */
  profileCompleteness: number;
  reservation: ReservationDetails;
}

export interface Message {
  id: string;
  body: string;
  /** ISO o etiqueta corta según build */
  sentAt: string;
  /**
   * ISO 8601 del mensaje (p. ej. `created_at` de la fila) para reglas de negocio
   * p. ej. ventana de 24 h de Meta; omitido en mensajes solo locales.
   */
  sentAtIso?: string;
  sender: MessageSender;
  /**
   * Columna `format` en Wubby_Whatsapp: `audio` = voz transcrito, `text` = texto, etc.
   */
  format?: string;
  messageType?: "text" | "image" | "video" | "audio" | "document" | "file" | string;
  mediaUrl?: string | null;
  mediaStoragePath?: string | null;
  mediaMimeType?: string | null;
  mediaCaption?: string | null;
  mediaFilename?: string | null;
  mediaBucket?: string | null;
  metaMediaId?: string | null;
  /**
   * Columna `wamid`: id de Meta del mensaje, clave contra la que resuelven las
   * reacciones. `null` en mensajes anteriores al 30 jul 2026 y en los
   * optimistas creados en cliente (aún sin fila en DB).
   */
  wamid?: string | null;
  /**
   * Columna `reaction_to_wamid`: no-null SOLO en filas de reacción, apuntando al
   * `wamid` del mensaje reaccionado. Estas filas no son burbujas: se pintan como
   * badge sobre su objetivo. Si el target no se encuentra, caen a burbuja de
   * texto normal.
   */
  reactionToWamid?: string | null;
  /**
   * Columna `cause_request`: `yes` = disparó escalación (badge en burbuja).
   */
  causeRequest?: string;
  /**
   * Columna `message_translated`: texto EXACTO que le llegó al huésped cuando el
   * engine tradujo la respuesta a su idioma. `null`/ausente = lo enviado es
   * idéntico a `body`, que siempre va en español (todo lo interno en español).
   *
   * Es solo lectura y solo informativo: la burbuja sigue mostrando `body` y no
   * hay ningún camino que reenvíe o edite este texto.
   */
  translatedBody?: string | null;
  /**
   * Columna `inbound_translation`: traducción AL ESPAÑOL de lo que escribió el
   * huésped. Solo en mensajes entrantes y solo cuando el engine tradujo.
   *
   * Al revés que `translatedBody`, esta SÍ es la vista por defecto de la
   * burbuja: `body` guarda el original en el idioma del huésped y nunca se
   * pierde (se abre a un toque bajo la marca "Traducido del …").
   */
  inboundTranslation?: string | null;
  /**
   * Columna `inbound_detected_lang`: ISO 639-1 del idioma del entrante. Puede
   * faltar aunque haya traducción; ahí la marca cae al copy genérico.
   */
  inboundDetectedLang?: string | null;
  aiMeta?: AiMessageMeta;
  /** UUID generado en cliente; persiste en `Wubby_Whatsapp.client_temp_id`. */
  clientTempId?: string;
  /** Solo mensajes salientes creados en cliente; histórico sin campo = confirmado en UI. */
  status?: MessageDeliveryStatus;
}

export interface Conversation {
  /** UUID de la fila en `conversations` */
  id: string;
  guest: Guest;
  lastMessagePreview: string;
  lastMessageAt: string;
  /** ISO 8601 del último mensaje (panel derecho) */
  lastActivityIso: string;
  unreadCount: number;
  /**
   * ISO 8601 del último mensaje ENTRANTE del huésped, copiado de
   * `conversations.last_guest_message_at` (timestamptz mantenida por trigger).
   *
   * `null` NO significa necesariamente que el huésped nunca escribió: el
   * trigger deja la columna vacía cuando la fila de `Wubby_Whatsapp` llega con
   * `conversation_id` en NULL. Por eso la ventana de 24 h no se decide solo con
   * este campo, sino con el máximo entre él y el último entrante del hilo
   * (`lib/meta-window.ts`). Nada de warnings ni estados de carga para el null.
   *
   * La columna ya viene con offset (timestamptz); `parseWhatsappInstantMs` lo
   * respeta y solo asume Bogotá en los timestamps naive de `Wubby_Whatsapp`.
   */
  lastGuestMessageAt: string | null;
  operationalStatus: OperationalStatus;
  controlMode: ControlMode;
  /**
   * Canal real de la conversación, ya normalizado. Decide el badge del
   * encabezado, si aplica la ventana de 24 h de Meta y si `guestPhone` se puede
   * mostrar como teléfono. Ver `lib/channels.ts`.
   */
  channel: MessageChannel;
  /** Nombre del canal para pintar (marca, no el valor crudo de la columna). */
  channelLabel: string;
  /**
   * Hilo de la conversación. Ojo: cuando llega desde `GET /api/inbox` es un
   * array PROVISIONAL (el recorte a `MESSAGES_LIMIT` de los mensajes que el
   * servidor pudo atribuir a este teléfono), no el historial del huésped. Solo
   * es autoritativo cuando `messagesLoaded === true`.
   */
  messages: Message[];
  /**
   * `true` únicamente cuando el hilo se cargó desde `GET /api/inbox/messages`.
   * Es un flag de cliente: el servidor lo emite siempre en `false`.
   *
   * OJO: autoritativo NO significa completo. El endpoint trae los últimos 50 y
   * lo anterior se pide con "Cargar anteriores" (`olderMessagesCursor`). La
   * ausencia de un mensaje VIEJO en `messages` no dice nada; la de uno de los
   * recientes sí.
   */
  messagesLoaded: boolean;
  /**
   * Cursor `<created_at>|<id>` del mensaje más viejo cargado, para pedir la
   * página anterior del hilo. `null`/ausente = no hay más atrás (o el hilo no
   * se cargó todavía). Flag de cliente, igual que `messagesLoaded`.
   */
  olderMessagesCursor?: string | null;
  /** Teléfono huésped normalizado (+E.164) para envío / matching */
  guestPhone: string;
  /**
   * `conversations.guest_phone` TAL CUAL viene de la base, sin normalizar.
   *
   * Existe porque en OTA el identificador del hilo es un UUID de Channex, y
   * `guestPhone` lo pasa por el normalizador de teléfonos, que le arranca los
   * guiones y deja un número inservible. El engine busca la conversación de OTA
   * con una comparación EXACTA contra esta columna, así que mandarle la versión
   * normalizada hace que no encuentre nada.
   *
   * Regla: para MOSTRAR y para emparejar mensajes en el cliente se usa
   * `guestPhone`; para hablarle al engine se usa el valor que devuelve
   * `resolveEngineGuestIdentity`, que elige entre los dos según el canal.
   */
  guestPhoneRaw: string;
  /** Copia de `conversations.needs_human` */
  needsHuman: boolean;
  /** Copia de `conversations.ai_active` */
  aiActive: boolean;
  /** Copia de `conversations.status` */
  dbStatus: string | null;
  /**
   * Fecha en que la IA volvió SOLA a la conversación (barrido del engine tras
   * ~2 h sin actividad humana), o `null` si la última reactivación la hizo una
   * persona desde el inbox.
   *
   * Existe para que la recepcionista distinga las dos cosas: una IA que volvió
   * sola en una conversación que ella creía suya no puede aparecer sin aviso.
   *
   * Opcional: las conversaciones que se construyen en cliente (optimistas) no
   * lo traen, y por Realtime llega solo si la fila se vuelve a emitir.
   */
  autoReactivatedAt?: string | null;
  /**
   * Fecha en que el triage del engine escaló esta conversación Y sigue sin
   * atender; `null` si ya la tomaron, la resolvieron o la cerraron.
   *
   * No es la columna cruda: `readTriageEscalatedAt` ya cruzó `ai_triage_at` con
   * `needs_human` y `status`. Quien lee este campo no tiene que volver a
   * decidir nada — si tiene fecha, hay un huésped esperando a una persona.
   *
   * Opcional por la misma razón que `autoReactivatedAt`: las conversaciones
   * optimistas que arma el cliente no lo traen.
   */
  triageEscalatedAt?: string | null;
  blocked: boolean;
  blockedAt: string | null;
  /**
   * Copia directa de `conversations.request`.
   * Cuando vale `"pending"`, la IA detectó que el caso requiere seguimiento humano.
   * El agente lo resuelve desde el inbox (vuelve a `null`).
   */
  request: string | null;
  /**
   * `true` cuando el teléfono del hilo está en `staff_contacts` (activo) del
   * hotel. NO es una columna de `conversations`: lo deriva `GET /api/inbox`
   * cruzando teléfonos normalizados, así que Realtime nunca lo trae.
   *
   * Por eso el merge de Realtime (`{ ...prev, ...cambios }`) lo conserva solo.
   * Consecuencia aceptada: una conversación que NACE por Realtime queda sin
   * marca hasta el próximo refetch de la bandeja.
   *
   * Opcional a propósito: las conversaciones construidas en cliente (optimistas,
   * mocks) simplemente no lo traen y se pintan como huésped.
   */
  isStaff?: boolean;
  /**
   * Solicitud de servicio pendiente (abierta o en curso) de esta conversación,
   * o `null`/ausente si no tiene ninguna.
   *
   * NO es una columna de `conversations`: sale de `service_tickets` y lo derivan
   * `GET /api/inbox` y `GET /api/inbox/ticket-badges`. Realtime no lo trae nunca
   * — el canal solo escucha `conversations` y los mensajes — y por eso existe el
   * refresco periódico del hook.
   *
   * El merge de Realtime (`{ ...prev, ...cambios }`) lo conserva solo, igual que
   * `isStaff`. Consecuencia aceptada: una conversación que NACE por Realtime
   * queda sin badge hasta el próximo refresco.
   *
   * Cuando tiene valor, REEMPLAZA al distintivo rojo "Sin atender" en la fila:
   * los dos ocupan el mismo lugar y este dice algo más concreto. El semáforo de
   * estado (IA / Humano / Pendiente) sigue apareciendo, porque responde a otra
   * pregunta: quién tiene el control de la conversación.
   */
  ticketBadge?: InboxTicketBadge | null;
}
