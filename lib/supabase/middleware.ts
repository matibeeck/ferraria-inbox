import { createServerClient } from "@supabase/ssr";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { INBOX_PATH, LOGIN_PATH } from "@/lib/routes";
import { cookieDomainOption } from "./cookie-domain";

/** Tope para cualquier llamada a Auth desde el middleware (refresh o getUser). */
const AUTH_TIMEOUT_MS = 8_000;

/**
 * Por debajo de este margen el access token se considera "por vencer" y se
 * valida contra Auth con `getUser()`. `getSession()` ya refresca solo cuando
 * quedan menos de 90 s (margen interno de supabase-js), así que en la práctica
 * este camino queda para un refresh que devolvió un token casi vencido.
 */
const MIN_TOKEN_LIFETIME_MS = 60_000;

function copyCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach(({ name, value, ...opts }) => {
    to.cookies.set(name, value, opts);
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), AUTH_TIMEOUT_MS);
    }),
  ]);
}

/**
 * Sesión leída de la cookie, SIN verificarla contra el servidor.
 *
 * Con el access token vigente `getSession()` solo decodifica la cookie: cero
 * viajes de red. Si al token le quedan menos de 90 s, supabase-js lo refresca
 * con el refresh token (un viaje a Auth) y reescribe las cookies vía `setAll`.
 *
 * No se lee `session.user`: sin verificar no es confiable, y en servidor
 * supabase-js avisa por consola si se toca. Acá solo importa si hay sesión.
 */
async function getSessionOrNull(supabase: SupabaseClient): Promise<Session | null> {
  try {
    const { data, error } = await withTimeout(supabase.auth.getSession(), "getSession");
    if (error) {
      console.warn("[middleware] getSession error:", error.message);
      return null;
    }
    return data.session;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[middleware] getSession no disponible (timeout o error):", msg);
    return null;
  }
}

/**
 * getUser() llama a la API de Auth; en Edge puede colgarse (red/DNS) y dejar
 * la app sin responder. Evitamos eso con un timeout explícito.
 */
async function getUserOrNull(supabase: SupabaseClient): Promise<User | null> {
  try {
    const { data, error } = await withTimeout(supabase.auth.getUser(), "getUser");
    if (error) {
      console.warn("[middleware] getUser error:", error.message);
      return null;
    }
    return data.user;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[middleware] getUser no disponible (timeout o error):", msg);
    return null;
  }
}

/**
 * ¿Hay sesión utilizable?
 *
 * - Access token vigente (>= 60 s): sí, sin ningún viaje a la base ni a Auth.
 * - Por vencer o vencido con refresh token: `getSession()` ya intentó el
 *   refresh; si igual quedó corto, `getUser()` lo valida contra Auth.
 * - Sin cookie o refresh fallido: no.
 *
 * Esto es UX, no seguridad: un token falsificado pasaría este filtro, pero cada
 * Route Handler vuelve a verificar con `getUser()` y responde 401/403. El
 * candado real vive ahí.
 */
async function hasUsableSession(supabase: SupabaseClient): Promise<boolean> {
  const session = await getSessionOrNull(supabase);
  if (!session?.access_token) return false;

  const expiresAtMs = session.expires_at != null ? session.expires_at * 1000 : 0;
  if (expiresAtMs - Date.now() >= MIN_TOKEN_LIFETIME_MS) return true;

  if (!session.refresh_token) return false;
  return (await getUserOrNull(supabase)) != null;
}

/**
 * Mantiene la sesión de Supabase y aplica reglas de acceso:
 * - Sin sesión: /api/* → 401; resto → /login
 * - Con sesión en /login → la bandeja
 *
 * El rebote por ROL (un `operativo` que cae en la bandeja o en Reservas) ya no
 * vive acá: costaba una consulta a `hotel_users` por navegación. Lo hace el
 * sidebar en el cliente con las capacidades que ya carga de `/api/me` (ver
 * `AppSidebar`). Sigue fallando abierto: si `/api/me` falla, no se redirige a
 * nadie, y el operativo ve una pantalla cuyos datos igual no puede cargar
 * porque cada endpoint tiene su gate de capacidad.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error("[middleware] Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, { ...options, ...cookieDomainOption() });
        });
      },
    },
  });

  const authenticated = await hasUsableSession(supabase);

  const pathname = request.nextUrl.pathname;

  if (authenticated && pathname === LOGIN_PATH) {
    const redirect = NextResponse.redirect(new URL(INBOX_PATH, request.url));
    copyCookies(supabaseResponse, redirect);
    return redirect;
  }

  if (!authenticated) {
    if (pathname.startsWith("/api")) {
      const unauthorized = NextResponse.json({ error: "No autorizado" }, { status: 401 });
      copyCookies(supabaseResponse, unauthorized);
      return unauthorized;
    }
    if (pathname !== LOGIN_PATH) {
      const loginUrl = new URL(LOGIN_PATH, request.url);
      loginUrl.searchParams.set("next", pathname);
      const redirect = NextResponse.redirect(loginUrl);
      copyCookies(supabaseResponse, redirect);
      return redirect;
    }
  }

  return supabaseResponse;
}
