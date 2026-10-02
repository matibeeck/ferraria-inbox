import "server-only";
import {
  interpretarRespuestaReactivarIa,
  resolverUrlReactivarIa,
  type ResultadoReactivarIa,
} from "@/lib/engine-reactivate-ai";

/**
 * Tope de espera. Más allá, el PATCH escribe directo: la recepcionista no puede
 * quedarse mirando un botón colgado. Si el engine terminaba igual, la escritura
 * directa repite el mismo estado y no encola nada: no hay doble respuesta.
 */
const TIMEOUT_MS = 8_000;

/**
 * Pide al engine que reactive la IA. `hotelId` es el AUTORITATIVO (el de la
 * fila ya verificada con `assertConversationInHotel`), nunca uno del cliente.
 *
 * Nunca lanza: cualquier fallo vuelve como `{ ok: false }` para que el PATCH
 * caiga al camino de siempre.
 */
export async function reactivarIaPorEngine(input: {
  conversationId: string;
  hotelId: string;
}): Promise<ResultadoReactivarIa> {
  const url = resolverUrlReactivarIa({
    ENGINE_REACTIVATE_AI_URL: process.env.ENGINE_REACTIVATE_AI_URL,
    ENGINE_HUMAN_REPLY_URL: process.env.ENGINE_HUMAN_REPLY_URL,
  });
  const secreto = process.env.INBOX_SHARED_SECRET;
  if (!url || !secreto) return { ok: false, motivo: "engine_no_configurado" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-inbox-secret": secreto },
      body: JSON.stringify({ conversationId: input.conversationId, hotelId: input.hotelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return interpretarRespuestaReactivarIa(res.status, body);
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.name : "error" };
  }
}
