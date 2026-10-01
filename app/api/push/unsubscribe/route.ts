import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const TABLE = "push_subscriptions";

type UnsubscribeBody = { endpoint?: string };

/** Elimina la suscripción Web Push de este endpoint para el usuario actual. */
export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as UnsubscribeBody;
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!endpoint) {
      return NextResponse.json({ error: "Falta el endpoint" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // Acotado por user_id: un usuario solo puede borrar sus propias suscripciones.
    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq("endpoint", endpoint)
      .eq("user_id", auth.user.id);

    if (error) {
      return apiError(502, "push_unsubscribe_failed", { cause: error, log: "[push/unsubscribe POST]", message: "No se pudo eliminar la suscripción" });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[push/unsubscribe POST]", message: "No se pudo eliminar la suscripción" });
  }
}
