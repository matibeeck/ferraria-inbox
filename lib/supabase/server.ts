import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { memoPerRequest } from "@/lib/request-memo";
import { cookieDomainOption } from "./cookie-domain";

async function buildClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }

  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, { ...options, ...cookieDomainOption() });
          });
        } catch {
          // Llamado desde un Server Component sin mutar cookies; el middleware mantiene la sesión.
        }
      },
    },
  });
}

/**
 * Cliente SSR con las cookies de la request. Uno solo por request: `cache()`
 * deduplica en Server Components y `memoPerRequest` en Route Handlers (ver
 * `lib/request-memo.ts` para por qué hacen falta los dos).
 */
export const createClient = cache(
  (): Promise<SupabaseClient> => memoPerRequest("supabase-ssr-client", buildClient)
);
