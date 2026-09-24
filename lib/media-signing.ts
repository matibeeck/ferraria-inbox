/**
 * Firma de media de `Wubby_Whatsapp` en Storage. Módulo puro (sin Supabase,
 * sin red) para probar la agrupación con `node --test`.
 */

/** Vida de la URL firmada, en segundos. El cliente la cachea 55 min. */
export const SIGNED_URL_TTL_SECONDS = 3600;

/** Nombre de bucket aceptable: nada que no calce se firma. */
export const VALID_BUCKET_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Bucket por defecto cuando la fila no trae `media_bucket`. Mismo orden de
 * respaldo que usó siempre `/api/media/signed-url`.
 */
export function defaultMediaBucket(): string {
  return (
    process.env.WHATSAPP_MEDIA_BUCKET ||
    process.env.NEXT_PUBLIC_WHATSAPP_MEDIA_BUCKET ||
    "hotel-media"
  );
}

/**
 * Agrupa las paths de una página por bucket para firmarlas con UN
 * `createSignedUrls` por bucket (en la práctica, uno solo).
 *
 * - Paths repetidas se firman una vez.
 * - Sin bucket propio → `fallbackBucket`.
 * - Un bucket con nombre inválido se descarta entero: esa media cae al
 *   endpoint unitario, que lo rechaza igual.
 */
export function groupStoragePathsByBucket(
  items: Array<{ path: string | null | undefined; bucket?: string | null }>,
  fallbackBucket: string
): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path) continue;
    const bucket = (typeof item.bucket === "string" ? item.bucket.trim() : "") || fallbackBucket;
    if (!VALID_BUCKET_RE.test(bucket)) continue;
    let set = groups.get(bucket);
    if (!set) {
      set = new Set();
      groups.set(bucket, set);
    }
    set.add(path);
  }
  return new Map([...groups].map(([bucket, paths]) => [bucket, [...paths]]));
}

/** Clave de la firma de una path dentro de su bucket. */
export function signedMediaKey(bucket: string, path: string): string {
  return `${bucket}\u0000${path}`;
}
