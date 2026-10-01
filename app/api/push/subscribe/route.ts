import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { resolveAllowedHotelIds } from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const TABLE = "push_subscriptions";

type SubscribeBody = {
  subscription?: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  hotelId?: string | null;
};

/** Guarda (o actualiza) la suscripción Web Push del navegador para el usuario. */
export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as SubscribeBody;

    const endpoint = typeof body.subscription?.endpoint === "string"
      ? body.subscription.endpoint.trim()
      : "";
    const p256dh = typeof body.subscription?.keys?.p256dh === "string"
      ? body.subscription.keys.p256dh
      : "";
    const authKey = typeof body.subscription?.keys?.auth === "string"
      ? body.subscription.keys.auth
      : "";

    if (!endpoint || !p256dh || !authKey) {
      return NextResponse.json(
        { error: "Suscripción inválida: faltan endpoint o claves" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServerClient();

    // Solo persistimos el hotel si pertenece al tenant del usuario (igual que feedback).
    let hotelId: string | null = null;
    const requestedHotelId = typeof body.hotelId === "string" ? body.hotelId.trim() : "";
    if (requestedHotelId) {
      const allowedHotelIds = await resolveAllowedHotelIds(supabase, auth.user);
      if (allowedHotelIds.includes(requestedHotelId)) {
        hotelId = requestedHotelId;
      }
    }

    const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

    // Upsert por endpoint: un mismo navegador se re-suscribe sin duplicar filas.
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        {
          user_id: auth.user.id,
          hotel_id: hotelId,
          endpoint,
          p256dh,
          auth: authKey,
          user_agent: userAgent,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" }
      );

    if (error) {
      return apiError(502, "push_subscribe_failed", { cause: error, log: "[push/subscribe POST]", message: "No se pudo guardar la suscripción" });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[push/subscribe POST]", message: "No se pudo guardar la suscripción" });
  }
}
