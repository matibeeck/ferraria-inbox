// Este módulo lleva la service role: si algún componente de cliente lo importa,
// el build falla en vez de mandar la llave al navegador.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Credenciales del cliente servidor, validadas al CARGAR el módulo.
 *
 * La service role no tiene fallback a la anon key. La RLS NO tiene políticas de
 * escritura para `authenticated`: todo INSERT/UPDATE pasa por route handlers con
 * service role. Con la anon key cada escritura afectaría 0 filas sin devolver
 * error, así que `PATCH /api/inbox` respondería 404 "Conversación no
 * encontrada" y la bandeja aparentaría funcionar mientras nada se guarda. Un
 * despliegue sin la variable debe no arrancar, no degradarse en silencio.
 *
 * Lectura con `authenticated` (lo que alcanzan el navegador y Realtime):
 * - `conversations` y `Wubby_Whatsapp`: SELECT filtrado por
 *   `hotel_id in (select user_guest_data_hotel_ids())`. Esa función excluye las
 *   membresías con rol `operativo` — mantenimiento y housekeeping no pueden leer
 *   datos de huéspedes; `super_admin` conserva acceso a todos los hoteles.
 * - `hotels`: SELECT filtrado por `id in (select user_hotel_ids())`.
 * - `hotel_users`: SELECT solo de la propia fila (`user_id = auth.uid()`).
 * - `service_tickets`: SELECT/UPDATE por hotel vía `hotel_users`; el INSERT es
 *   exclusivo del engine con service role.
 *
 * La anon key sigue siendo legítima donde el control de acceso ES la RLS y la
 * autoriza el JWT del usuario: `lib/supabase/client.ts` (navegador),
 * `lib/supabase/server.ts` (SSR con cookies) y `lib/supabase/middleware.ts`.
 * Ninguno pasa por acá.
 */
function readServerCredentials(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    const missing = [
      url ? null : "NEXT_PUBLIC_SUPABASE_URL",
      serviceRoleKey ? null : "SUPABASE_SERVICE_ROLE_KEY",
    ]
      .filter(Boolean)
      .join(", ");

    throw new Error(
      `[supabase-server] Faltan variables de entorno obligatorias: ${missing}. ` +
        "El cliente servidor exige la service role; la anon key NO es un fallback válido " +
        "porque la RLS solo tiene políticas de SELECT y toda escritura fallaría en silencio."
    );
  }

  return { url, serviceRoleKey };
}

const { url: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY } = readServerCredentials();

let cached: SupabaseClient | null = null;

/**
 * Cliente Supabase solo para servidor (Route Handlers, Server Components).
 * Siempre con `SUPABASE_SERVICE_ROLE_KEY`: omite RLS a propósito, por eso cada
 * llamador es responsable de su propio gate de tenancy (`requireSessionUser` +
 * `assertConversationInHotel` / `requireActiveHotel`).
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
