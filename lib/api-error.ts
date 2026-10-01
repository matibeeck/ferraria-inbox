import { NextResponse } from "next/server";
import { buildApiErrorBody, errorCodeForLog, isDev, type ApiErrorBody } from "./api-error-body.ts";

export { buildApiErrorBody, errorCodeForLog, isDev, type ApiErrorBody };

/**
 * Respuesta de error de una API route sin filtrar detalle crudo en producción.
 *
 * - `code`: código corto (`reservas_query_failed`), va al cliente y al log.
 * - `message`: copy en español que puede ver la recepcionista. El campo
 *   `error` sigue siendo texto legible porque la bandeja lo muestra en toasts.
 * - `cause`: el error de Supabase o la excepción. Solo se expone con `isDev`.
 * - `log`: etiqueta del `console.error`. En producción se loguea solo
 *   status + código; en desarrollo, la causa completa.
 */
export function apiError(
  status: number,
  code: string,
  options: { message?: string; cause?: unknown; log?: string } = {}
): NextResponse<ApiErrorBody> {
  const { message, cause, log } = options;
  if (log) {
    if (isDev) console.error(log, status, code, cause ?? "");
    else console.error(log, status, code, cause == null ? "" : errorCodeForLog(cause));
  }
  return NextResponse.json(buildApiErrorBody(code, message, cause, isDev), { status });
}
