import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireSessionUser } from "@/lib/auth/require-user";
import { resolveAllowedHotelIds } from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const FEEDBACK_TABLE = "feedback";
const VALID_CATEGORIES = new Set(["suggestion", "bug", "other"]);
const MESSAGE_MAX_LENGTH = 2000;

/** Registra feedback del agente. Escribe con el cliente de servidor (service role). */
export async function POST(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as {
      message?: string;
      category?: string;
      rating?: number;
      hotelId?: string | null;
      pageUrl?: string;
    };

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json({ error: "El mensaje es obligatorio" }, { status: 400 });
    }
    if (message.length > MESSAGE_MAX_LENGTH) {
      return NextResponse.json(
        { error: `El mensaje no puede superar ${MESSAGE_MAX_LENGTH} caracteres` },
        { status: 400 }
      );
    }

    const category =
      typeof body.category === "string" && VALID_CATEGORIES.has(body.category)
        ? body.category
        : "other";

    let rating: number | null = null;
    if (
      typeof body.rating === "number" &&
      Number.isInteger(body.rating) &&
      body.rating >= 1 &&
      body.rating <= 5
    ) {
      rating = body.rating;
    }

    const supabase = getSupabaseServerClient();

    // Solo persistimos el hotel si pertenece al tenant del usuario.
    let hotelId: string | null = null;
    const requestedHotelId = typeof body.hotelId === "string" ? body.hotelId.trim() : "";
    if (requestedHotelId) {
      const allowedHotelIds = await resolveAllowedHotelIds(supabase, auth.user);
      if (allowedHotelIds.includes(requestedHotelId)) {
        hotelId = requestedHotelId;
      }
    }

    const pageUrl =
      typeof body.pageUrl === "string" && body.pageUrl.trim()
        ? body.pageUrl.trim().slice(0, 500)
        : null;
    const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

    const { error } = await supabase.from(FEEDBACK_TABLE).insert({
      user_id: auth.user.id,
      user_email: auth.user.email ?? null,
      hotel_id: hotelId,
      category,
      message,
      rating,
      page_url: pageUrl,
      user_agent: userAgent,
    });

    if (error) {
      return apiError(502, "feedback_insert_failed", { cause: error, log: "[feedback POST]", message: "No se pudo guardar el feedback" });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(500, "unexpected_error", { cause: e, log: "[feedback POST]", message: "No se pudo guardar el feedback" });
  }
}
