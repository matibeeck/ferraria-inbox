/**
 * Aviso automático al huésped cuando recepción marca una solicitud como
 * resuelta. Módulo puro — sin React, sin Supabase, sin red.
 *
 * Toda la decisión de "se manda o no se manda" vive acá para que se pueda
 * testear sin tocar WhatsApp: el route handler junta los datos, esta función
 * decide, y el envío lo hace el mismo camino que una respuesta humana normal
 * (`POST /inbox/human-reply` del engine, ver `lib/aviso-cierre-server.ts`).
 *
 * Cancelar NO avisa: una solicitud cancelada no se atendió y decirle "listo"
 * al huésped sería mentirle.
 */

// Imports relativos CON extensión: este módulo lo cubre `node --test`, que no
// resuelve los alias de `tsconfig.paths`.
import { normalizeArea, type TicketArea } from "./push/audience.ts";
import { COLOMBIA_TIME_ZONE, META_REPLY_WINDOW_MS, parseWhatsappInstantMs } from "./meta-window.ts";
import type { TicketEstado } from "./service-tickets.ts";

/**
 * Clave del jsonb `hotel_agent_config.settings` que apaga el aviso en un hotel.
 * Mismo prefijo `service_tickets_` que las demás claves de tickets que ya lee
 * el engine (`service_tickets_categorias_desactivadas`).
 */
export const CLAVE_AVISO_CIERRE = "service_tickets_aviso_cierre_enabled";

/**
 * ¿Está activado el aviso en este hotel?
 *
 * Ausente = ACTIVADO. Solo el booleano `false` lo apaga: un jsonb sin fila, sin
 * la clave, con `null` o con un typo (`"false"` como texto) deja el aviso
 * prendido. Es la misma filosofía del engine con sus flags de tickets: un error
 * de tipeo nunca puede apagar en silencio algo que funciona.
 */
export function avisoCierreActivado(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return true;
  return (settings as Record<string, unknown>)[CLAVE_AVISO_CIERRE] !== false;
}

/** Por qué NO se le avisó al huésped. Viaja tal cual en la respuesta del PATCH. */
export const MOTIVOS_SIN_AVISO = [
  "desactivado_hotel",
  "sin_conversacion",
  "canal_no_whatsapp",
  "conversacion_bloqueada",
  "ya_le_escribieron",
  "fuera_de_ventana",
  "no_verificado",
  "envio_fallido",
] as const;
export type MotivoSinAviso = (typeof MOTIVOS_SIN_AVISO)[number];

export function isMotivoSinAviso(raw: unknown): raw is MotivoSinAviso {
  return typeof raw === "string" && (MOTIVOS_SIN_AVISO as readonly string[]).includes(raw);
}

/**
 * Habitación apta para ir en el mensaje, o `null`.
 *
 * El número lo extrae el engine de lo que escribió el huésped, así que puede
 * venir cualquier cosa ("la del fondo", "no sé"). Solo se usa si tiene forma de
 * número de habitación —corto, alfanumérico y con al menos un dígito—: ante la
 * duda el mensaje sale sin habitación antes que con una inventada.
 */
export function habitacionParaMensaje(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 8) return null;
  if (!/^[A-Za-z0-9-]+$/.test(value)) return null;
  if (!/\d/.test(value)) return null;
  return value;
}

/** Texto del WhatsApp por categoría. Español colombiano, con tuteo. */
export function textoAvisoCierre(
  categoria: string | null | undefined,
  habitacion?: string | null
): string {
  const area: TicketArea = normalizeArea(categoria);
  const hab = habitacionParaMensaje(habitacion);

  switch (area) {
    case "housekeeping":
      return `¡Listo! Tu solicitud de aseo y amenities${hab ? ` en la habitación ${hab}` : ""} ya fue atendida. Si necesitas algo más, escríbenos 😊`;
    case "mantenimiento":
      return `¡Listo! Tu reporte de mantenimiento${hab ? ` en la habitación ${hab}` : ""} ya fue atendido. Si algo sigue sin funcionar, cuéntanos 😊`;
    case "room_service":
      return `¡Listo! Tu pedido${hab ? ` a la habitación ${hab}` : ""} ya fue atendido. Si necesitas algo más, escríbenos 😊`;
    default:
      return `¡Listo! Tu solicitud${hab ? ` de la habitación ${hab}` : ""} ya fue atendida. Si necesitas algo más, escríbenos 😊`;
  }
}

/** Lo que el route handler junta antes de decidir. */
export type EntradaAvisoCierre = {
  /** Estado al que pasó la solicitud con un UPDATE EFECTIVO. */
  hacia: TicketEstado;
  ticket: {
    categoria: string | null;
    habitacion: string | null;
    conversation_id: string | null;
    /** `service_tickets.created_at`: timestamptz, llega con offset. */
    created_at: string | null;
  };
  /** `hotel_agent_config.settings` crudo; `null` = el hotel no tiene fila. */
  settings: unknown;
  /**
   * La conversación del ticket, ya verificada como del MISMO hotel. `null` si
   * no existe o no es de este hotel.
   */
  conversacion: {
    guestPhone: string | null;
    channel: string | null;
    blocked: boolean | null;
  } | null;
  /** Último `Human Answer`/`Human Template` saliente (`Wubby_Whatsapp.created_at`, hora Bogotá sin zona). */
  ultimoHumanoSalienteAt: string | null;
  /** `conversations.last_guest_message_at` (timestamptz). */
  ultimoEntranteColumnaAt: string | null;
  /** Último entrante del huésped en `Wubby_Whatsapp` (hora Bogotá sin zona). */
  ultimoEntranteHiloAt: string | null;
  /** Alguna lectura falló: no se puede afirmar que mandar sea seguro. */
  verificacionFallida?: boolean;
  ahoraMs: number;
};

export type DecisionAvisoCierre =
  | { enviar: true; texto: string }
  | { enviar: false; motivo: MotivoSinAviso };

/**
 * ¿Se le manda el aviso al huésped? `null` = no aplica (no fue a `resuelto`).
 *
 * El orden de los chequeos es el orden en que se le explica a recepción: lo
 * que depende de la configuración del hotel primero, después lo que depende de
 * la conversación, y al final la ventana de Meta.
 *
 * Zonas horarias: `Wubby_Whatsapp.created_at` es hora Bogotá SIN zona y
 * `service_tickets.created_at` es timestamptz CON offset. Las dos pasan por
 * `parseWhatsappInstantMs`, que respeta el offset cuando viene y asume Bogotá
 * cuando no: así se comparan instantes reales y no textos corridos 5 horas.
 */
export function decidirAvisoCierre(entrada: EntradaAvisoCierre): DecisionAvisoCierre | null {
  if (entrada.hacia !== "resuelto") return null;

  if (!avisoCierreActivado(entrada.settings)) {
    return { enviar: false, motivo: "desactivado_hotel" };
  }

  const conversationId =
    typeof entrada.ticket.conversation_id === "string" ? entrada.ticket.conversation_id.trim() : "";
  if (!conversationId) return { enviar: false, motivo: "sin_conversacion" };

  if (entrada.verificacionFallida) return { enviar: false, motivo: "no_verificado" };

  const conversacion = entrada.conversacion;
  const guestPhone = typeof conversacion?.guestPhone === "string" ? conversacion.guestPhone.trim() : "";
  if (!conversacion || !guestPhone) return { enviar: false, motivo: "sin_conversacion" };

  // Valor desconocido o nulo = WhatsApp, la misma regla que `normalizeChannel`.
  const canal = typeof conversacion.channel === "string" ? conversacion.channel.trim().toLowerCase() : "";
  if (canal === "booking" || canal === "expedia" || canal === "airbnb") {
    return { enviar: false, motivo: "canal_no_whatsapp" };
  }

  if (conversacion.blocked === true) return { enviar: false, motivo: "conversacion_bloqueada" };

  // Sin fecha legible del ticket no hay contra qué comparar: no se puede
  // descartar que recepción ya le haya escrito, así que no se manda.
  const ticketMs = parseWhatsappInstantMs(entrada.ticket.created_at);
  if (ticketMs === null) return { enviar: false, motivo: "no_verificado" };

  const humanoMs = parseWhatsappInstantMs(entrada.ultimoHumanoSalienteAt);
  if (humanoMs !== null && humanoMs > ticketMs) {
    return { enviar: false, motivo: "ya_le_escribieron" };
  }

  // Igual que el composer: se toma el MÁS RECIENTE de las dos fuentes, para que
  // ninguna pueda cerrar una ventana que la otra dice abierta.
  const columnaMs = parseWhatsappInstantMs(entrada.ultimoEntranteColumnaAt);
  const hiloMs = parseWhatsappInstantMs(entrada.ultimoEntranteHiloAt);
  const ultimoEntranteMs =
    columnaMs === null ? hiloMs : hiloMs === null ? columnaMs : Math.max(columnaMs, hiloMs);
  // Sin entrante conocido no hay ventana abierta: Meta rechazaría el texto
  // libre. No se usa plantilla: simplemente no se manda.
  if (ultimoEntranteMs === null || entrada.ahoraMs - ultimoEntranteMs > META_REPLY_WINDOW_MS) {
    return { enviar: false, motivo: "fuera_de_ventana" };
  }

  return {
    enviar: true,
    texto: textoAvisoCierre(entrada.ticket.categoria, entrada.ticket.habitacion),
  };
}

/**
 * Opciones de envío del aviso hacia `POST /inbox/human-reply`. `automatico`
 * va SIEMPRE: el aviso no es recepción tomando la conversación, así que el
 * engine no debe apagar la IA, ni marcarla como en manos de recepción, ni
 * poner los no leídos en 0. La conversación queda exactamente como estaba.
 */
export function opcionesEnvioAvisoCierre(targetLang: string | null): {
  targetLang: string | null;
  automatico: true;
} {
  return { targetLang, automatico: true };
}

/** Resultado del aviso tal como viaja en la respuesta del PATCH. */
export type AvisoCierre = { enviado: boolean; motivo?: MotivoSinAviso };

/**
 * Motivos que NO dicen nada de la conversación del huésped. Son los únicos que
 * puede ver alguien sin acceso a datos de huéspedes (p. ej. un operativo de
 * mantenimiento): "recepción ya le escribió" o "pasaron más de 24 h desde su
 * último mensaje" ya son datos de la conversación.
 */
const MOTIVOS_SIN_DATOS_DEL_HUESPED: ReadonlySet<MotivoSinAviso> = new Set([
  "desactivado_hotel",
  "envio_fallido",
]);

/** El aviso recortado a lo que este usuario puede saber. */
export function avisoVisiblePara(aviso: AvisoCierre, puedeVerConversaciones: boolean): AvisoCierre {
  if (aviso.enviado || puedeVerConversaciones) return aviso;
  return aviso.motivo && MOTIVOS_SIN_DATOS_DEL_HUESPED.has(aviso.motivo)
    ? aviso
    : { enviado: false };
}

/** Lo que ve recepción en pantalla después de tocar "Resolver". Texto plano. */
export function mensajeAvisoParaRecepcion(aviso: AvisoCierre): string {
  if (aviso.enviado) return "Se le avisó al huésped";
  switch (aviso.motivo) {
    case "ya_le_escribieron":
      return "No se avisó: recepción ya le escribió";
    case "fuera_de_ventana":
      return "No se avisó: pasaron más de 24 h desde su último mensaje";
    case "desactivado_hotel":
      return "No se avisó: el aviso está desactivado en este hotel";
    case "sin_conversacion":
      return "No se avisó: la solicitud no tiene conversación";
    case "canal_no_whatsapp":
      return "No se avisó: la conversación no es de WhatsApp";
    case "conversacion_bloqueada":
      return "No se avisó: la conversación está bloqueada";
    case "no_verificado":
      return "No se avisó: no se pudo revisar la conversación";
    case "envio_fallido":
      return "No se avisó: falló el envío del WhatsApp";
    default:
      return "No se avisó al huésped";
  }
}

const FORMATO_HORA = new Intl.DateTimeFormat("es-CO", {
  timeZone: COLOMBIA_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * "hh:mm" en hora Bogotá del momento en que se avisó, o `null` si la fecha no
 * se puede leer. Fija Bogotá a propósito: una tablet configurada en otra zona
 * no puede mostrar una hora que en el hotel no fue.
 */
export function horaAvisoHuesped(raw: string | null | undefined): string | null {
  const ms = parseWhatsappInstantMs(raw);
  if (ms === null) return null;
  return FORMATO_HORA.format(new Date(ms));
}
