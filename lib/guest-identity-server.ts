import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeChannel, pickEngineIdentity } from "@/lib/channels";
import { normalizeGuestIdentityKey } from "@/lib/chat-utils";
import { CONVERSATIONS_TABLE } from "@/lib/conversation-schema";

/**
 * Destinatario de un envío humano, tomado de la conversación YA validada y
 * nunca del body.
 *
 * Las rutas de envío corren con service role: si el teléfono saliera del body,
 * cualquiera con sesión podría usar la línea de WhatsApp de su hotel para
 * escribirle a un número cualquiera, con una conversación ajena como coartada.
 *
 * El body puede seguir mandando el teléfono por compatibilidad; si no coincide
 * con el de la conversación, la ruta responde 400 y no sale nada.
 */
export type ConversationRecipient =
  | {
      ok: true;
      /** Identidad que espera `/inbox/human-reply`: crudo en OTA, normalizado en WhatsApp. */
      engineTextIdentity: string;
      /** Identidad que manda el adjunto: teléfono en dígitos o LID crudo. */
      mediaIdentity: string;
      /** `true` si el valor del body no apunta a este huésped. */
      bodyMismatch: boolean;
    }
  | { ok: false; status: 404 | 502; code: string };

export async function resolveConversationRecipient(
  supabase: SupabaseClient,
  conversationId: string,
  hotelId: string,
  bodyIdentity: string | null | undefined
): Promise<ConversationRecipient> {
  const { data, error } = await supabase
    .from(CONVERSATIONS_TABLE)
    .select("guest_phone, channel")
    .eq("id", conversationId)
    .eq("hotel_id", hotelId)
    .maybeSingle<{ guest_phone: string | null; channel: string | null }>();

  if (error) return { ok: false, status: 502, code: "conversation_lookup_failed" };

  const raw = String(data?.guest_phone ?? "").trim();
  if (!data || !raw) return { ok: false, status: 404, code: "guest_phone_not_found" };

  // Mismas reglas que el cliente (`resolveEngineGuestIdentity` y el
  // `normalizeGuestIdentityKey` del adjunto), calculadas sobre la fila.
  const key = normalizeGuestIdentityKey(raw);
  const engineTextIdentity = pickEngineIdentity(normalizeChannel(data.channel), raw, key);

  const client = String(bodyIdentity ?? "").trim();
  const bodyMismatch =
    client !== "" && client !== raw && (key === "" || normalizeGuestIdentityKey(client) !== key);

  return { ok: true, engineTextIdentity, mediaIdentity: key || raw, bodyMismatch };
}

/** Copy para la bandeja según por qué no se pudo resolver el destinatario. */
export function recipientErrorCopy(status: 404 | 502): string {
  return status === 404
    ? "No se encontró el número del huésped de esta conversación."
    : "No se pudo verificar el destinatario. Intenta de nuevo en un momento.";
}
