import { cache } from "react";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { memoPerRequest } from "@/lib/request-memo";

/**
 * Usuario de la sesión verificado contra Supabase Auth, UNA vez por request.
 *
 * Es un viaje de red: `getUser()` valida el JWT contra el servidor de Auth.
 * El proyecto firma con HS256 (clave simétrica), así que `getClaims()` no puede
 * verificar localmente y caería a la misma llamada de red. Cuando el proyecto
 * migre a claves asimétricas (RS256/ES256), esto se puede cambiar a
 * `getClaims()` y la verificación pasa a ser local, sin viaje.
 *
 * `null` = sin sesión o sesión inválida.
 */
export const getSessionUserCached = cache(
  (): Promise<User | null> =>
    memoPerRequest("session-user", async () => {
      const supabase = await createClient();
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();
      return error || !user ? null : user;
    })
);

/**
 * Valida sesión en Route Handlers (cookies). Tras esto puedes usar
 * `getSupabaseServerClient()` para datos con service role / anon de servidor.
 */
export async function requireSessionUser() {
  const user = await getSessionUserCached();

  if (!user) {
    return {
      user: null as null,
      response: NextResponse.json({ error: "No autorizado" }, { status: 401 }),
    };
  }

  return { user, response: null as null };
}
