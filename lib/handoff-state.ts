/**
 * Estado de la solicitud a recepción ("handoff") de una conversación, tal como
 * lo tiene que ver la bandeja.
 *
 * El engine tiene dos formas de pasarle un caso a recepción:
 *  - PAUSA TOTAL: `needs_human=true` (o `ai_active=false`). La IA se calla y la
 *    conversación ya cae en "Atención" por `operationalStatus`. No cambia.
 *  - CONSULTA ("consultar y seguir", opt-in por hotel): `request='pending'` con
 *    la IA ACTIVA. Recepción tiene que revisar el tema, pero el agente sigue
 *    atendiendo todo lo demás. Sin este módulo esa conversación caía en la
 *    pestaña "IA" y nadie la veía como pendiente.
 *
 * Lógica pura y sin imports para que la cubra `node --test` sin compilar nada.
 */

/** Lo mínimo de una conversación que hace falta para decidir. */
export interface HandoffStateInput {
  request: string | null;
  needsHuman: boolean;
  aiActive: boolean;
  blocked: boolean;
  dbStatus: string | null;
  operationalStatus: "ai_active" | "requires_attention" | "closed";
}

/** Solicitud abierta con recepción (en cualquiera de los dos modos). */
export function hasPendingRequest(c: Pick<HandoffStateInput, "request">): boolean {
  return c.request === "pending";
}

/**
 * Modo consulta: solicitud abierta con la IA atendiendo. Es exactamente lo que
 * deja el engine en ese modo (request pendiente sin `needs_human`). Cualquier
 * señal de control humano —needs_human, IA apagada, `human_control`, bloqueo—
 * la vuelve pausa total, que es como se ve hoy.
 */
export function isConsultMode(c: HandoffStateInput): boolean {
  return (
    hasPendingRequest(c) &&
    !c.needsHuman &&
    c.aiActive &&
    !c.blocked &&
    String(c.dbStatus ?? "").toLowerCase() !== "human_control" &&
    c.operationalStatus !== "closed"
  );
}

/**
 * ¿Va en la pestaña y el contador "Atención"? Todo lo que ya iba (pausa total,
 * bloqueo, control humano) MÁS cualquier solicitud abierta con recepción,
 * aunque la IA siga activa. Una conversación cerrada no entra, como hoy.
 */
export function needsReceptionAttention(c: HandoffStateInput): boolean {
  if (c.operationalStatus === "requires_attention") return true;
  return hasPendingRequest(c) && c.operationalStatus !== "closed";
}

/**
 * Frases cortas para recepción de los motivos que escribe el engine en
 * `conversations.handoff_reason` (src/pipeline/handoffReasons.ts). El engine ya
 * los guarda en español, pero largos para una fila o un encabezado.
 *
 * Si llega un valor que no está acá (un motivo nuevo del engine, o uno viejo de
 * n8n), se muestra TAL CUAL: mejor un texto largo que un motivo escondido.
 */
const HANDOFF_REASON_LABELS: Record<string, string> = {
  "El huésped envió un archivo": "Envió un archivo",
  "La IA no pudo resolver la conversación": "La IA no pudo resolverlo",
  "Consulta de tarifas que la IA no pudo resolver": "Cotización para revisar",
  "El huésped quiere reservar y hay que confirmarlo": "Reserva por confirmar",
  "El huésped pide un artículo o servicio que no está documentado: confirmar si el hotel lo ofrece":
    "Confirmar si el hotel ofrece lo que pide",
  "La IA falló al responder y no se le pudo contestar al huésped": "La IA falló al responder",
  "Mensaje no entregado por rechazo de la plataforma": "Mensaje no entregado",
  "WhatsApp no pudo entregarle el mensaje al huésped": "Mensaje no entregado",
  "El huésped envió un mensaje que la IA no puede leer": "Mensaje que la IA no puede leer",
};

/** Motivo legible, o null si no hay motivo. */
export function handoffReasonLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return HANDOFF_REASON_LABELS[trimmed] ?? trimmed;
}
