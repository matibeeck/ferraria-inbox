import type { SupabaseClient } from "@supabase/supabase-js";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";
import { isWaLidIdentifier, normalizeGuestIdentityKey, normalizePhoneDigits, readWaLid } from "@/lib/chat-utils";
import { CONVERSATIONS_TABLE } from "@/lib/conversation-schema";
import {
  avisoCierreActivado,
  decidirAvisoCierre,
  opcionesEnvioAvisoCierre,
  type AvisoCierre,
} from "@/lib/aviso-cierre";
import { normalizeChannel } from "@/lib/channels";
import { enviarTextoHumanoPorEngine } from "@/lib/engine-human-reply-server";
import { buildGuestHistoryOrFilter } from "@/lib/inbox-fetch-messages";
import { DEFAULT_COMPOSER_LANGUAGE, normalizeLanguageCode } from "@/lib/language-names";
import { SERVICE_TICKETS_TABLE, type ServiceTicket } from "@/lib/service-tickets";
import { WUBBY_TABLE } from "@/lib/wubby-schema";

/**
 * Lado servidor del aviso de cierre: junta los datos, le pregunta a
 * `decidirAvisoCierre` (puro, testeado) y, si toca, manda el WhatsApp por el
 * mismo endpoint del engine que usa el composer, marcado como `automatico`:
 * el engine no toma el control de la conversación por este mensaje.
 *
 * Regla de oro: NADA de acá puede tumbar el cierre. La solicitud ya quedó
 * resuelta antes de llamar a esta función; cualquier falla termina en
 * `{ enviado: false, motivo }` y el PATCH responde 200 igual.
 */

const isDev = process.env.NODE_ENV !== "production";

/** Literales con los que el inbox y el engine marcan lo que escribió recepción. */
const SENDERS_HUMANOS = ["Human Answer", "Human Template"] as const;

/** Errores que garantizan que no salió nada y que el español sí podría salir. */
const ERRORES_DE_TRADUCCION = new Set(["translation_failed", "translation_not_supported", "invalid_target_lang"]);

function logFallo(contexto: string, detalle: unknown) {
  // Solo el código de error en producción: el detalle de Supabase puede traer
  // valores de la fila.
  const codigo =
    detalle && typeof detalle === "object" && "code" in detalle
      ? String((detalle as { code?: unknown }).code ?? "")
      : "";
  console.error(`[aviso-cierre ${contexto}]`, isDev ? detalle : codigo || "error");
}

/** Remitentes con los que el huésped aparece en `Wubby_Whatsapp` (con y sin `+`). */
function identidadesDelHuesped(guestPhone: string): string[] {
  if (isWaLidIdentifier(guestPhone)) return [readWaLid(guestPhone)];
  const digits = normalizePhoneDigits(guestPhone);
  return digits ? [digits, `+${digits}`] : [];
}

async function leerSettingsHotel(
  supabase: SupabaseClient,
  hotelId: string
): Promise<{ settings: unknown; fallo: boolean }> {
  const { data, error } = await supabase
    .from("hotel_agent_config")
    .select("settings")
    .eq("hotel_id", hotelId)
    .limit(1)
    .maybeSingle();
  if (error) {
    logFallo("settings", error);
    return { settings: null, fallo: true };
  }
  return { settings: (data as { settings?: unknown } | null)?.settings ?? null, fallo: false };
}

export async function avisarCierreAlHuesped(params: {
  supabase: SupabaseClient;
  /** Fila ya resuelta, leída del UPDATE efectivo. */
  ticket: ServiceTicket;
  /** Hotel AUTORITATIVO: el `hotel_id` de la fila del ticket. */
  hotelId: string;
  /** `hotels.engine_enabled` del hotel: solo ahí existe la traducción de salida. */
  engineEnabled: boolean;
}): Promise<{ aviso: AvisoCierre; guestNotifiedAt: string | null }> {
  const { supabase, ticket, hotelId, engineEnabled } = params;
  const ahoraMs = Date.now();

  try {
    const base = {
      hacia: "resuelto" as const,
      ticket: {
        categoria: ticket.categoria,
        habitacion: ticket.habitacion,
        conversation_id: ticket.conversation_id,
        created_at: ticket.created_at,
      },
      conversacion: null,
      ultimoHumanoSalienteAt: null,
      ultimoEntranteColumnaAt: null,
      ultimoEntranteHiloAt: null,
      ahoraMs,
    };

    const { settings, fallo: falloSettings } = await leerSettingsHotel(supabase, hotelId);
    const conversationId = ticket.conversation_id?.trim() ?? "";

    // Corte temprano: apagado, sin conversación o sin poder leer la config. El
    // motivo lo sigue poniendo la función pura; acá solo se evita gastar
    // consultas que no van a cambiar la respuesta.
    if (falloSettings || !conversationId || !avisoCierreActivado(settings)) {
      const previa = decidirAvisoCierre({ ...base, settings, verificacionFallida: falloSettings });
      const motivo = previa && !previa.enviar ? previa.motivo : "no_verificado";
      return { aviso: { enviado: false, motivo }, guestNotifiedAt: null };
    }

    // La conversación tiene que ser del MISMO hotel que el ticket. Se pasa solo
    // ese hotel como permitido: aunque el usuario tenga acceso a otro, un
    // ticket nunca le escribe a un huésped de otra propiedad.
    const ownership = await assertConversationInHotel(supabase, conversationId, [hotelId]);
    if (ownership.response) {
      if (ownership.response.status === 403) {
        console.warn("[aviso-cierre] la conversación del ticket es de otro hotel", { ticket_id: ticket.id });
      }
      const motivo = ownership.response.status >= 500 ? "no_verificado" : "sin_conversacion";
      return { aviso: { enviado: false, motivo }, guestNotifiedAt: null };
    }

    const { data: conv, error: errorConv } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select("guest_phone, channel, blocked, last_guest_message_at")
      .eq("id", conversationId)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (errorConv) {
      logFallo("conversación", errorConv);
      return { aviso: { enviado: false, motivo: "no_verificado" }, guestNotifiedAt: null };
    }

    const fila = conv as {
      guest_phone?: string | null;
      channel?: string | null;
      blocked?: boolean | null;
      last_guest_message_at?: string | null;
    } | null;
    const guestPhone = fila?.guest_phone?.trim() ?? "";
    const identidades = identidadesDelHuesped(guestPhone);
    const filtroConversacion = guestPhone ? buildGuestHistoryOrFilter(guestPhone, conversationId) : "";

    let ultimoHumanoSalienteAt: string | null = null;
    let ultimoEntranteHiloAt: string | null = null;
    let idiomaHuesped: string | null = null;
    let verificacionFallida = false;

    // OTA o bloqueada: la función pura ya va a decir que no; no se lee el hilo.
    const valeLeerHilo =
      fila !== null && normalizeChannel(fila.channel) === "whatsapp" && fila.blocked !== true;

    if (valeLeerHilo && guestPhone && identidades.length > 0 && filtroConversacion) {
      const [humano, entrante] = await Promise.all([
        // Último mensaje de recepción en ESTA conversación. Por
        // `conversation_id` y, de respaldo, por el teléfono del huésped como
        // destinatario: las filas que escribe n8n pueden venir sin
        // `conversation_id` y no se pueden perder para el dedupe.
        supabase
          .from(WUBBY_TABLE)
          .select("created_at")
          .eq("hotel_id", hotelId)
          .in("sender", [...SENDERS_HUMANOS])
          .or(filtroConversacion)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Último entrante del huésped en este hotel: la ventana de Meta es por
        // par de números, no por fila de `conversations`.
        supabase
          .from(WUBBY_TABLE)
          .select("created_at, inbound_detected_lang")
          .eq("hotel_id", hotelId)
          .in("sender", identidades)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (humano.error || entrante.error) {
        logFallo("hilo", humano.error ?? entrante.error);
        verificacionFallida = true;
      } else {
        ultimoHumanoSalienteAt = (humano.data as { created_at?: string | null } | null)?.created_at ?? null;
        const filaEntrante = entrante.data as {
          created_at?: string | null;
          inbound_detected_lang?: string | null;
        } | null;
        ultimoEntranteHiloAt = filaEntrante?.created_at ?? null;
        idiomaHuesped = normalizeLanguageCode(filaEntrante?.inbound_detected_lang);
      }
    }

    const decision = decidirAvisoCierre({
      ...base,
      settings,
      verificacionFallida,
      conversacion: fila
        ? { guestPhone, channel: fila.channel ?? null, blocked: fila.blocked ?? null }
        : null,
      ultimoHumanoSalienteAt,
      ultimoEntranteColumnaAt: fila?.last_guest_message_at ?? null,
      ultimoEntranteHiloAt,
    });

    if (!decision) return { aviso: { enviado: false, motivo: "no_verificado" }, guestNotifiedAt: null };
    if (!decision.enviar) return { aviso: { enviado: false, motivo: decision.motivo }, guestNotifiedAt: null };

    // Mismo criterio que el composer: si el huésped escribe en otro idioma y el
    // hotel ya responde por el engine, el engine traduce. En hoteles n8n no hay
    // traducción y se manda el español tal cual.
    const targetLang =
      engineEnabled && idiomaHuesped && idiomaHuesped !== DEFAULT_COMPOSER_LANGUAGE ? idiomaHuesped : null;
    const envio = {
      guestPhone: normalizeGuestIdentityKey(guestPhone),
      message: decision.texto,
      conversationId,
      hotelId,
    };

    let resultado = await enviarTextoHumanoPorEngine({ ...envio, ...opcionesEnvioAvisoCierre(targetLang) });
    // Si falló SOLO la traducción, el engine garantiza que no salió nada: se
    // reintenta una vez en español en vez de dejar al huésped sin aviso.
    if (
      !resultado.ok &&
      targetLang &&
      resultado.seguroQueNoSalio &&
      resultado.codigo &&
      ERRORES_DE_TRADUCCION.has(resultado.codigo)
    ) {
      resultado = await enviarTextoHumanoPorEngine({ ...envio, ...opcionesEnvioAvisoCierre(null) });
    }

    if (!resultado.ok) {
      return { aviso: { enviado: false, motivo: "envio_fallido" }, guestNotifiedAt: null };
    }

    // El aviso ya salió: si esta marca falla, se loguea y nada más. La tarjeta
    // no dirá "Huésped avisado", pero el toast de esta respuesta sí.
    const guestNotifiedAt = new Date().toISOString();
    const { error: errorMarca } = await supabase
      .from(SERVICE_TICKETS_TABLE)
      .update({ guest_notified_at: guestNotifiedAt })
      .eq("id", ticket.id)
      .eq("hotel_id", hotelId);
    if (errorMarca) {
      logFallo("marca", errorMarca);
      return { aviso: { enviado: true }, guestNotifiedAt: null };
    }

    return { aviso: { enviado: true }, guestNotifiedAt };
  } catch (e) {
    logFallo("inesperado", e);
    return { aviso: { enviado: false, motivo: "no_verificado" }, guestNotifiedAt: null };
  }
}
