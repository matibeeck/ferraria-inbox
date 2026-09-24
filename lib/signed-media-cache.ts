/**
 * Caché en memoria del navegador de URLs firmadas de media, indexada por
 * `storagePath`. Vive solo en la página (se pierde al refrescar).
 *
 * La siembra `GET /api/inbox/messages`, que ya firma en lote la media de cada
 * página del hilo; `/api/media/signed-url` queda como respaldo cuando una URL
 * falta o venció.
 */
const cache = new Map<string, { url: string; expiresAt: number }>();

/**
 * TTL cliente conservador: el servidor firma a 1 h; se cachea ~55 min para
 * nunca servir una URL a punto de expirar. Se cuenta con el reloj del
 * navegador desde que llega, no con el `expiresAt` del servidor, para no
 * depender de que los dos relojes coincidan.
 */
export const SIGNED_URL_CLIENT_TTL_MS = 55 * 60 * 1000;

export function readCachedSignedUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const hit = cache.get(path);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(path);
    return null;
  }
  return hit.url;
}

export function writeCachedSignedUrl(path: string, url: string): void {
  cache.set(path, { url, expiresAt: Date.now() + SIGNED_URL_CLIENT_TTL_MS });
}

/** Siembra la caché con las URLs que ya vinieron firmadas en una página del hilo. */
export function seedSignedUrlsFromMessages(
  messages: Array<{ mediaStoragePath?: string | null; mediaSignedUrl?: string | null }>
): void {
  for (const m of messages) {
    if (m.mediaStoragePath && m.mediaSignedUrl) {
      writeCachedSignedUrl(m.mediaStoragePath, m.mediaSignedUrl);
    }
  }
}
