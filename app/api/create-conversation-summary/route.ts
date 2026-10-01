import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/** El cuerpo del engine puede traer el resumen de la conversación: solo en dev. */
const isDev = process.env.NODE_ENV !== "production";

/**
 * Resumen devuelto por el engine de forma síncrona. Si el cuerpo no trae
 * `summary` (p. ej. rollback a un worker asíncrono), devolvemos `null` y el
 * cliente cae a leer `conversation_summaries`.
 */
function readEngineSummary(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).summary;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // Cuerpo no-JSON: sin resumen síncrono.
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as { conversation_id?: string };
    const conversation_id = body.conversation_id?.trim();
    if (!conversation_id) {
      return NextResponse.json({ error: "conversation_id es obligatorio" }, { status: 400 });
    }

    // Ownership antes de disparar la generación de IA (evita generar resúmenes
    // de conversaciones de otros hoteles / abuso de recurso).
    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    const ownership = await assertConversationInHotel(supabase, conversation_id, allowedHotelIds);
    if (ownership.response) return ownership.response;

    // Sin URL o sin secreto NO hay generación: fallar explícito, nunca caer a
    // un destino por defecto.
    const engineUrl = process.env.ENGINE_SUMMARY_URL;
    const sharedSecret = process.env.INBOX_SHARED_SECRET;
    if (!engineUrl || !sharedSecret) {
      console.error(
        "[create-conversation-summary] faltan ENGINE_SUMMARY_URL o INBOX_SHARED_SECRET"
      );
      return NextResponse.json(
        {
          error:
            "Resumen no configurado: faltan ENGINE_SUMMARY_URL o INBOX_SHARED_SECRET",
        },
        { status: 500 }
      );
    }

    const res = await fetch(engineUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inbox-secret": sharedSecret,
      },
      body: JSON.stringify({ conversation_id }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("[create-conversation-summary] engine", res.status, isDev ? text : "");
    }

    // El engine devuelve el resumen en el body; si no viene, el cliente cae a
    // leer `conversation_summaries` (compatibilidad con rollback a n8n).
    return NextResponse.json({
      ok: true,
      engineOk: res.ok,
      engineStatus: res.status,
      summary: res.ok ? readEngineSummary(text) : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
