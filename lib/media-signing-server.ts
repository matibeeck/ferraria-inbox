import type { SupabaseClient } from "@supabase/supabase-js";
import { SIGNED_URL_TTL_SECONDS, signedMediaKey } from "@/lib/media-signing";

export type SignedMedia = { url: string; expiresAt: string };

/**
 * Firma las paths agrupadas por bucket: UN `createSignedUrls` por bucket, todos
 * en paralelo. Devuelve `bucket+path → URL`.
 *
 * El candado de tenencia es de quien llama: las paths tienen que salir de
 * filas ya filtradas por hotel y conversación (no hace falta el lookup por
 * path del endpoint unitario, que existe porque ahí la path la manda el
 * navegador).
 *
 * Best-effort: un bucket que falla deja sus mensajes sin URL y el cliente cae
 * a `/api/media/signed-url` para esos. Nunca tumba la respuesta del hilo.
 */
export async function signStoragePathsByBucket(
  supabase: SupabaseClient,
  groups: Map<string, string[]>
): Promise<Map<string, SignedMedia>> {
  const out = new Map<string, SignedMedia>();
  if (groups.size === 0) return out;

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

  await Promise.all(
    [...groups].map(async ([bucket, paths]) => {
      if (paths.length === 0) return;
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
      if (error) {
        console.error("[media] firma en lote", { bucket, count: paths.length });
        return;
      }
      for (const entry of data ?? []) {
        if (entry.error || !entry.signedUrl || !entry.path) continue;
        out.set(signedMediaKey(bucket, entry.path), { url: entry.signedUrl, expiresAt });
      }
    })
  );

  return out;
}
