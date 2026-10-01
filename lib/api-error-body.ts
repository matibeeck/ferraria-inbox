/**
 * Parte pura de `apiError` (sin Next): decide qué detalle de un error puede
 * salir del servidor. Separada para poder probarla con `node --test`.
 */

/**
 * `true` fuera de producción. Único lugar donde se decide si un detalle crudo
 * (mensaje de Supabase, `details`, `hint`, excepción) puede salir del servidor.
 */
export const isDev = process.env.NODE_ENV !== "production";

/** Copy por defecto cuando la ruta no trae uno propio. */
const DEFAULT_PUBLIC_MESSAGE = "Algo salió mal. Intenta de nuevo en un momento.";

type ErrorRecord = { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };

function asRecord(cause: unknown): ErrorRecord | null {
  return cause && typeof cause === "object" ? (cause as ErrorRecord) : null;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Lo único del error que se puede loguear en producción: el `code` de
 * Postgres/PostgREST (p. ej. `23505`, `PGRST116`) o el nombre de la excepción.
 * Nunca el `message`/`details`/`hint`, que pueden traer valores de la fila
 * (teléfonos, nombres) o el texto de un mensaje.
 */
export function errorCodeForLog(cause: unknown): string {
  const record = asRecord(cause);
  const code = asText(record?.code);
  if (code) return code;
  if (cause instanceof Error) return cause.name;
  return "sin_code";
}

export type ApiErrorBody = {
  /** Copy en español para mostrar tal cual en la bandeja. */
  error: string;
  /** Código corto y estable, para el cliente y los logs. */
  code: string;
  message?: string;
  details?: string;
  hint?: string;
};

/**
 * Cuerpo del error. En producción solo `{ error, code }`; con `dev` además el
 * `message/details/hint` crudo de la causa. Pura, para poder probarla.
 */
export function buildApiErrorBody(
  code: string,
  publicMessage: string | undefined,
  cause: unknown,
  dev: boolean
): ApiErrorBody {
  const body: ApiErrorBody = { error: publicMessage ?? DEFAULT_PUBLIC_MESSAGE, code };
  if (!dev || cause == null) return body;

  const record = asRecord(cause);
  const message = cause instanceof Error ? cause.message : asText(record?.message);
  const details = asText(record?.details);
  const hint = asText(record?.hint);
  if (message) body.message = message;
  if (details) body.details = details;
  if (hint) body.hint = hint;
  return body;
}

