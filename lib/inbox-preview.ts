/**
 * Largo máximo del preview del último mensaje en la fila de la bandeja.
 *
 * Módulo puro para poder probarlo con `node --test`: lo usan el handler de
 * `GET /api/inbox` (vía `buildInboxConversations`) y el camino Realtime, y los
 * dos tienen que cortar igual o la misma fila cambiaría de texto según por
 * dónde llegó.
 */
export const LIST_PREVIEW_MAX_CHARS = 120;

/**
 * Corta el preview a lo sumo `LIST_PREVIEW_MAX_CHARS` (117 + "…", el corte
 * que ya tenían la fila y Realtime antes de extraerlo acá). Es lo ÚNICO
 * del cuerpo del mensaje que viaja en la respuesta de la bandeja: el texto
 * completo se queda en el servidor.
 */
export function truncateListPreview(preview: string): string {
  if (preview.length <= LIST_PREVIEW_MAX_CHARS) return preview;
  return `${preview.slice(0, LIST_PREVIEW_MAX_CHARS - 3)}…`;
}
