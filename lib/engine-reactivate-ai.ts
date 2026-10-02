/**
 * Botón "Reactivar IA" por el engine: `POST /inbox/reactivate-ai`.
 *
 * Antes el PATCH de la bandeja escribía los flags directo en la base y lo que
 * el huésped había escrito durante la pausa quedaba sin respuesta para siempre
 * (Tigo, 2026-10-02). Ahora el engine escribe el MISMO estado y, si la
 * conversación estaba muda y quedaron mensajes sin contestar dentro de la
 * ventana de 24 h de Meta, corre un turno normal del agente sobre ellos.
 *
 * Módulo puro —sin red ni Supabase— para que `node --test` lo pueda verificar.
 * El fetch vive en `engine-reactivate-ai-server.ts`.
 */

/** Ruta del engine. */
export const RUTA_REACTIVAR_IA = "/inbox/reactivate-ai";

/**
 * URL del endpoint. Cada endpoint del engine tiene su propia variable con la
 * URL completa; si no está, se deriva del origen de la de respuestas humanas
 * para no exigir una variable nueva en el despliegue.
 */
export function resolverUrlReactivarIa(env: {
  ENGINE_REACTIVATE_AI_URL?: string;
  ENGINE_HUMAN_REPLY_URL?: string;
}): string | null {
  const explicita = env.ENGINE_REACTIVATE_AI_URL?.trim();
  if (explicita) return explicita;

  const base = env.ENGINE_HUMAN_REPLY_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.pathname = RUTA_REACTIVAR_IA;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export type ResultadoReactivarIa =
  /**
   * El engine escribió el estado. `replay` dice qué pasó con lo pendiente
   * ('queued' = el agente lo va a contestar); es informativo.
   */
  | { ok: true; replay: string | null }
  /**
   * El engine NO lo hizo (endpoint inexistente en un engine viejo, hotel que
   * sigue en n8n, engine caído…). Quien llama escribe directo, como siempre.
   */
  | { ok: false; motivo: string };

/** Traduce la respuesta del engine. Solo un 200 con `ok: true` cuenta como hecho. */
export function interpretarRespuestaReactivarIa(status: number, body: unknown): ResultadoReactivarIa {
  const cuerpo = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (status === 200 && cuerpo?.ok === true) {
    return { ok: true, replay: typeof cuerpo.replay === "string" ? cuerpo.replay : null };
  }
  const codigo = typeof cuerpo?.error === "string" ? cuerpo.error : "sin_codigo";
  return { ok: false, motivo: `${status}:${codigo}` };
}
