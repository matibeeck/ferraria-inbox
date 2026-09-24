/** Fila de la tabla `conversations` (estado de bandeja). */
export const CONVERSATIONS_TABLE = "conversations";

/**
 * Columnas de `conversations` que consume la bandeja, en vez de `select("*")`.
 *
 * Queda FUERA `last_read_at`: la escribe el PATCH `mark_read` pero no la lee
 * nadie en cliente ni en el merge.
 *
 * Incluida por duda: `hotel_id`, que el merge no usa pero es el discriminador
 * de tenant y su ausencia haría mentir al cast `as ConversationDbRow`.
 */
export const CONVERSATION_SELECT_COLUMNS = [
  "id",
  "hotel_id",
  "guest_phone",
  "guest_name",
  "channel",
  "status",
  "needs_human",
  "ai_active",
  "cotizacion",
  "blocked",
  "blocked_at",
  "request",
  "unread_count",
  "last_guest_message_at",
  "ai_reactivated_at",
  "ai_reactivation_source",
  "ai_triage_at",
  "created_at",
  "updated_at",
].join(", ");

export type ConversationDbRow = {
  id: string;
  hotel_id?: string | null;
  guest_phone: string | null;
  guest_name: string | null;
  /**
   * Canal de origen: `whatsapp` (default de la columna) o uno de OTA
   * (`booking`, `expedia`, `airbnb`), que entran por Channex.
   *
   * Se lee SIEMPRE con `normalizeChannel` (`lib/channels.ts`), nunca casteando:
   * el engine puede agregar un canal nuevo antes que el inbox y un valor
   * desconocido debe caer a `whatsapp`, no romper la fila.
   *
   * OJO: cuando NO es `whatsapp`, `guest_phone` no es un teléfono sino el UUID
   * del hilo de Channex.
   */
  channel: string | null;
  status: string | null;
  needs_human: boolean | null;
  ai_active: boolean | null;
  cotizacion: string | null;
  blocked: boolean | null;
  blocked_at: string | null;
  /**
   * Marca operativa cuando la IA detecta que el caso necesita atención humana.
   * - "pending": la IA marcó el caso para seguimiento humano
   * - null / otro valor: caso sin pendiente activo
   */
  request: string | null;
  unread_count: number | null;
  /**
   * OPCIONAL a propósito: queda fuera de `CONVERSATION_SELECT_COLUMNS` (ver
   * nota arriba), así que las filas que devuelven el GET de bandeja y el PATCH
   * no la traen. Solo se escribe (`mark_read`, `buildReactivateAiFields`);
   * ningún lector la consume. Declararla requerida obligaba a mentir con un
   * cast en cada punto donde se construye un `ConversationDbRow` desde el
   * select acotado.
   */
  last_read_at?: string | null;
  /**
   * Último mensaje ENTRANTE del huésped (timestamptz, trigger AFTER INSERT en
   * `Wubby_Whatsapp` + backfill). `null` = el huésped nunca escribió.
   */
  last_guest_message_at: string | null;
  /**
   * Última vez que la IA volvió a quedar activa en la conversación, junto con
   * quién la devolvió: "manual" (botón del inbox) o "auto" (el barrido del
   * engine, que la devuelve sola tras ~2 h sin actividad humana).
   *
   * `human_control_at` queda FUERA a propósito: es el reloj interno del barrido
   * y la bandeja no lo muestra. Se escribe desde el PATCH, no se lee acá.
   */
  ai_reactivated_at: string | null;
  ai_reactivation_source: string | null;
  /**
   * Última vez que el triage de reactivación del engine ESCALÓ esta
   * conversación: quedó abandonada más de ~2 h con `needs_human` y el
   * clasificador vio que el huésped espera algo que solo una persona resuelve
   * (factura, confirmación de reserva, pago, cancelación).
   *
   * `null` = nunca escaló por triage. El engine solo la escribe en el caso
   * escalado; las que reactiva en silencio o contestando no la tocan.
   *
   * NO es por sí sola una señal de "esto sigue sin atender": es una marca
   * histórica que el engine nunca limpia. Quién sigue pendiente lo decide
   * `readTriageEscalatedAt` cruzándola con `needs_human` y `status`.
   */
  ai_triage_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Columna generada `coalesce(last_guest_message_at, created_at)`: la clave de
   * orden de la bandeja y del cursor keyset de `GET /api/inbox`. Opcional
   * porque solo la pide la consulta de páginas; el PATCH y Realtime no la
   * necesitan para nada visible.
   */
  sort_activity_at?: string | null;
};

export type InboxPatchAction =
  | "human_control"
  | "reactivate_ai"
  | "completed"
  | "resolve_request"
  | "reopen"
  | "mark_read"
  | "rename";

/** Largo máximo permitido para `guest_name` editado desde el inbox. */
export const GUEST_NAME_MAX_LENGTH = 80;
