/**
 * Paginación keyset de la bandeja y del hilo.
 *
 * Módulo puro — sin Supabase, sin React, sin red — para que el predicado se
 * pueda probar con `node --test` sin levantar nada.
 *
 * Por qué keyset y no `offset`: la bandeja y el hilo cambian mientras se
 * recorren (entran conversaciones y mensajes nuevos arriba). Con `offset` cada
 * inserción corre la ventana un lugar y la página siguiente repite o se salta
 * filas. Con el cursor "todo lo que está estrictamente DESPUÉS de esta fila en
 * el orden" las inserciones arriba no mueven nada de lo que falta por traer.
 *
 * El orden es SIEMPRE `(columna desc, id desc)`: la columna sola no es única
 * (hay `created_at` repetidos en `Wubby_Whatsapp`) y sin el desempate por `id`
 * el borde de página podría duplicar u omitir filas empatadas.
 */

/** Cursor: valor de la columna de orden (puede ser null) + id de la fila. */
export type KeysetCursor = {
  sortValue: string | null;
  id: string;
};

const CURSOR_SEPARATOR = "|";

/**
 * Timestamp tal cual lo devuelve PostgREST: `timestamp` (naive, como
 * `Wubby_Whatsapp.created_at` en hora Colombia) o `timestamptz` (con offset).
 * Nada más entra al filtro: el valor viaja interpolado en un `or=(...)`.
 */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_PATTERN = /^\d{1,19}$/;

/** `conversations.id` es uuid; `Wubby_Whatsapp.id` puede ser entero. */
export function isKeysetId(value: string): boolean {
  return UUID_PATTERN.test(value) || BIGINT_PATTERN.test(value);
}

export function isKeysetTimestamp(value: string): boolean {
  return TIMESTAMP_PATTERN.test(value);
}

/** `<valor>|<id>`; valor null viaja como cadena vacía (`|<id>`). */
export function encodeKeysetCursor(sortValue: string | null | undefined, id: string | number): string {
  const sort = typeof sortValue === "string" ? sortValue.trim() : "";
  return `${sort}${CURSOR_SEPARATOR}${String(id).trim()}`;
}

/**
 * Parsea y VALIDA el cursor que manda el cliente. `null` = inválido: el
 * handler responde 400 en vez de interpolar algo que no controla.
 */
export function parseKeysetCursor(raw: string | null | undefined): KeysetCursor | null {
  const value = String(raw ?? "").trim();
  const sep = value.lastIndexOf(CURSOR_SEPARATOR);
  if (sep < 0) return null;

  const sortRaw = value.slice(0, sep).trim();
  const id = value.slice(sep + 1).trim();
  if (!isKeysetId(id)) return null;
  if (sortRaw && !isKeysetTimestamp(sortRaw)) return null;

  return { sortValue: sortRaw || null, id };
}

/**
 * Predicado "estrictamente después del cursor" para un orden
 * `(sortColumn desc, idColumn desc)` con la semántica por defecto de Postgres
 * en `desc`: NULLS FIRST. Es exactamente lo que emite hoy
 * `.order(col, { ascending: false })` y lo que cubren los índices
 * `(… sort_activity_at desc, id desc)` y `(conversation_id, created_at desc, id desc)`.
 *
 * Devuelve el cuerpo de un `.or(...)` de supabase-js:
 *
 * - Cursor con valor X: las filas con valor menor, o con el mismo valor e id
 *   menor. Las filas con null quedaron ANTES (nulls first), ya se recorrieron.
 * - Cursor con valor null: las demás filas null con id menor, y después TODAS
 *   las no-null.
 *
 * Los timestamps van entre comillas dobles: llevan `:` y `.` y, en
 * `timestamptz`, un `+` de offset.
 */
export function buildDescKeysetOrFilter(
  sortColumn: string,
  idColumn: string,
  cursor: KeysetCursor
): string {
  if (cursor.sortValue === null) {
    return `and(${sortColumn}.is.null,${idColumn}.lt.${cursor.id}),${sortColumn}.not.is.null`;
  }
  const quoted = `"${cursor.sortValue}"`;
  return `${sortColumn}.lt.${quoted},and(${sortColumn}.eq.${quoted},${idColumn}.lt.${cursor.id})`;
}

/**
 * Comparador en memoria con el MISMO orden que el predicado: `(sort desc
 * nulls first, id desc)`. Sirve para mezclar dos consultas ordenadas y
 * quedarse con el tope global sin volver a la base.
 *
 * Los ids se comparan numéricamente si ambos son enteros y como texto si no.
 * Los timestamps se comparan como texto: dentro de una misma columna PostgREST
 * los devuelve con el mismo formato, así que el orden lexicográfico coincide
 * con el cronológico salvo en la precisión fraccional, que se normaliza acá.
 */
export function compareDescKeyset(
  a: { sortValue: string | null; id: string },
  b: { sortValue: string | null; id: string }
): number {
  if (a.sortValue !== b.sortValue) {
    if (a.sortValue === null) return -1;
    if (b.sortValue === null) return 1;
    const sa = normalizeTimestampForCompare(a.sortValue);
    const sb = normalizeTimestampForCompare(b.sortValue);
    if (sa !== sb) return sa > sb ? -1 : 1;
  }
  return compareIdsDesc(a.id, b.id);
}

function compareIdsDesc(a: string, b: string): number {
  if (BIGINT_PATTERN.test(a) && BIGINT_PATTERN.test(b)) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na === nb ? 0 : na > nb ? -1 : 1;
  }
  return a === b ? 0 : a > b ? -1 : 1;
}

/** `2026-09-24T10:00:00.5` y `2026-09-24T10:00:00.500000` deben empatar. */
function normalizeTimestampForCompare(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(.*)$/.exec(value);
  if (!match) return value;
  const [, date, time, fraction = "", rest] = match;
  return `${date}T${time}.${fraction.padEnd(6, "0")}${rest}`;
}
