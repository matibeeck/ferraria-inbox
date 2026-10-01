/**
 * Cuerpo de `POST /inbox/human-reply` del engine para los envíos que salen del
 * SERVIDOR del inbox (hoy, solo el aviso de cierre de solicitudes). Módulo
 * puro — sin red ni Supabase — para que `node --test` pueda verificarlo.
 *
 * El composer (`app/api/send-human-message/route.ts`) arma su propio cuerpo y
 * NO pasa por acá a propósito: es la ruta que usa recepción en vivo y nunca
 * debe mandar `automatico`.
 */

export type EntradaPayloadHumanReply = {
  guestPhone: string;
  message: string;
  /** ISO 639-1 distinto de español, o `null` para mandarlo tal cual. */
  targetLang: string | null;
  conversationId: string;
  hotelId: string;
  whatsappPhoneNumberId: string | null;
  whatsappNumber: string | null;
  sentAt: string;
  clientTempId: string;
  /**
   * `true` = mensaje automático del sistema: el engine lo manda igual
   * (traducción incluida) pero NO le quita la conversación a la IA ni toca
   * los no leídos, y lo guarda como mensaje de sistema, no como "Human Answer".
   * Obligatorio para que ningún llamado nuevo lo herede sin decidirlo.
   */
  automatico: boolean;
};

export function construirPayloadHumanReply(entrada: EntradaPayloadHumanReply) {
  return {
    guestPhone: entrada.guestPhone,
    message: entrada.message,
    // Solo una de las dos grafías: mandar las dos es `conflicting_target_lang`.
    ...(entrada.targetLang ? { targetLang: entrada.targetLang } : {}),
    conversationId: entrada.conversationId,
    hotelId: entrada.hotelId,
    whatsappPhoneNumberId: entrada.whatsappPhoneNumberId,
    whatsappNumber: entrada.whatsappNumber,
    source: "FerrarIA-inbox",
    sentAt: entrada.sentAt,
    clientTempId: entrada.clientTempId,
    // Solo viaja cuando es `true`: sin el campo el engine se comporta como
    // siempre, y un engine viejo lo ignora.
    ...(entrada.automatico === true ? { automatico: true as const } : {}),
  };
}
