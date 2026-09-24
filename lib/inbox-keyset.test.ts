import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDescKeysetOrFilter,
  compareDescKeyset,
  encodeKeysetCursor,
  mergeKeysetPages,
  parseKeysetCursor,
  type KeysetCursor,
} from "./inbox-keyset.ts";

const CONV_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("cursor de la bandeja: ida y vuelta con timestamptz", () => {
  const encoded = encodeKeysetCursor("2026-09-24T15:04:05.123456+00:00", CONV_ID);
  assert.equal(encoded, `2026-09-24T15:04:05.123456+00:00|${CONV_ID}`);
  assert.deepEqual(parseKeysetCursor(encoded), {
    sortValue: "2026-09-24T15:04:05.123456+00:00",
    id: CONV_ID,
  });
});

test("cursor del hilo: timestamp naive de Wubby e id entero", () => {
  const encoded = encodeKeysetCursor("2026-09-24T10:04:05.5", 98765);
  assert.deepEqual(parseKeysetCursor(encoded), { sortValue: "2026-09-24T10:04:05.5", id: "98765" });
});

test("cursor con valor null viaja vacío y vuelve como null", () => {
  const encoded = encodeKeysetCursor(null, CONV_ID);
  assert.equal(encoded, `|${CONV_ID}`);
  assert.deepEqual(parseKeysetCursor(encoded), { sortValue: null, id: CONV_ID });
});

test("un cursor que no valida no llega al filtro", () => {
  // Todo esto terminaría interpolado en un `or=(...)` de PostgREST.
  assert.equal(parseKeysetCursor(""), null);
  assert.equal(parseKeysetCursor("sin-separador"), null);
  assert.equal(parseKeysetCursor(`2026-09-24T10:00:00|no-es-id`), null);
  assert.equal(parseKeysetCursor(`2026-09-24),id.gt.0|${CONV_ID}`), null);
  assert.equal(parseKeysetCursor(`ayer|${CONV_ID}`), null);
  assert.equal(parseKeysetCursor(`2026-09-24T10:00:00|1,id.gt.0`), null);
});

test("predicado keyset: menor valor, o mismo valor con id menor", () => {
  const cursor: KeysetCursor = { sortValue: "2026-09-24T15:04:05+00:00", id: CONV_ID };
  assert.equal(
    buildDescKeysetOrFilter("sort_activity_at", "id", cursor),
    `sort_activity_at.lt."2026-09-24T15:04:05+00:00",and(sort_activity_at.eq."2026-09-24T15:04:05+00:00",id.lt.${CONV_ID})`
  );
});

test("predicado keyset con cursor null: resto de nulls y después todas las no-null", () => {
  // `desc` en Postgres es NULLS FIRST: después de un null vienen los null con
  // id menor y, detrás, todo lo que tiene valor.
  assert.equal(
    buildDescKeysetOrFilter("sort_activity_at", "id", { sortValue: null, id: CONV_ID }),
    `and(sort_activity_at.is.null,id.lt.${CONV_ID}),sort_activity_at.not.is.null`
  );
});

/**
 * Simula el predicado en memoria sobre un set con empates y nulls, y verifica
 * que recorrer por páginas da exactamente el mismo orden que ordenar todo de
 * una vez: sin duplicados ni huecos en los bordes.
 */
test("paginar con el cursor recorre todo sin repetir ni saltar filas", () => {
  type Row = { sortValue: string | null; id: string };
  const rows: Row[] = [
    { sortValue: null, id: "3" },
    { sortValue: null, id: "9" },
    { sortValue: "2026-09-24T10:00:00", id: "5" },
    { sortValue: "2026-09-24T10:00:00", id: "7" },
    { sortValue: "2026-09-24T10:00:00", id: "6" },
    { sortValue: "2026-09-23T09:00:00", id: "1" },
    { sortValue: "2026-09-25T08:00:00", id: "2" },
    { sortValue: "2026-09-23T09:00:00", id: "12" },
  ];

  const matches = (row: Row, cursor: KeysetCursor): boolean => {
    // Réplica literal de lo que dice el filtro armado por buildDescKeysetOrFilter.
    if (cursor.sortValue === null) {
      return (row.sortValue === null && BigInt(row.id) < BigInt(cursor.id)) || row.sortValue !== null;
    }
    if (row.sortValue === null) return false;
    return (
      row.sortValue < cursor.sortValue ||
      (row.sortValue === cursor.sortValue && BigInt(row.id) < BigInt(cursor.id))
    );
  };

  const expected = [...rows].sort(compareDescKeyset).map((r) => r.id);
  assert.deepEqual(expected, ["9", "3", "2", "7", "6", "5", "12", "1"]);

  const seen: string[] = [];
  let cursor: KeysetCursor | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = [...rows]
      .filter((r) => (cursor ? matches(r, cursor) : true))
      .sort(compareDescKeyset)
      .slice(0, 3);
    if (page.length === 0) break;
    seen.push(...page.map((r) => r.id));
    const last = page.at(-1)!;
    cursor = parseKeysetCursor(encodeKeysetCursor(last.sortValue, last.id));
  }

  assert.deepEqual(seen, expected);
});

test("el comparador empata timestamps con distinta precisión fraccional", () => {
  assert.equal(
    compareDescKeyset(
      { sortValue: "2026-09-24T10:00:00.5", id: "1" },
      { sortValue: "2026-09-24T10:00:00.500000", id: "1" }
    ),
    0
  );
  // Más reciente primero.
  assert.ok(
    compareDescKeyset(
      { sortValue: "2026-09-24T10:00:00.6", id: "1" },
      { sortValue: "2026-09-24T10:00:00.55", id: "1" }
    ) < 0
  );
});

test("hilo: predicado keyset sobre created_at naive e id entero", () => {
  const cursor = parseKeysetCursor("2026-09-24T10:04:05.123456|98765");
  assert.ok(cursor);
  assert.equal(
    buildDescKeysetOrFilter("created_at", "id", cursor),
    'created_at.lt."2026-09-24T10:04:05.123456",and(created_at.eq."2026-09-24T10:04:05.123456",id.lt.98765)'
  );
});

type Msg = { created_at: string; id: number; source: string };
const keyOf = (m: Msg) => ({ sortValue: m.created_at, id: String(m.id) });

test("hilo: mezclar la consulta por conversation_id con la de filas huérfanas da el tope global", () => {
  // A: filas con conversation_id. B: filas viejas sin conversation_id que
  // matchean por teléfono, intercaladas en el tiempo con las de A.
  const byConversation: Msg[] = [
    { created_at: "2026-09-24T10:00:05", id: 50, source: "A" },
    { created_at: "2026-09-24T10:00:03", id: 30, source: "A" },
    { created_at: "2026-09-24T10:00:01", id: 10, source: "A" },
  ];
  const orphans: Msg[] = [
    { created_at: "2026-09-24T10:00:04", id: 40, source: "B" },
    { created_at: "2026-09-24T10:00:02", id: 20, source: "B" },
    { created_at: "2026-09-24T10:00:00", id: 5, source: "B" },
  ];

  const { page, hasMore } = mergeKeysetPages([byConversation, orphans], keyOf, 4);
  assert.deepEqual(page.map((m) => m.id), [50, 40, 30, 20]);
  assert.equal(hasMore, true);
});

test("hilo: una fila que llega por las dos consultas cuenta una vez", () => {
  const row: Msg = { created_at: "2026-09-24T10:00:05", id: 7, source: "A" };
  const { page, hasMore } = mergeKeysetPages([[row], [{ ...row, source: "B" }]], keyOf, 50);
  assert.equal(page.length, 1);
  assert.equal(hasMore, false);
});

test("hilo: sin nada detrás del tope no hay 'cargar anteriores'", () => {
  const rows: Msg[] = Array.from({ length: 50 }, (_, i) => ({
    created_at: `2026-09-24T10:${String(i).padStart(2, "0")}:00`,
    id: i + 1,
    source: "A",
  }));
  const exact = mergeKeysetPages([rows, []], keyOf, 50);
  assert.equal(exact.page.length, 50);
  assert.equal(exact.hasMore, false);

  const oneMore = mergeKeysetPages([rows, [{ created_at: "2026-09-23T09:00:00", id: 999, source: "B" }]], keyOf, 50);
  assert.equal(oneMore.hasMore, true);
  // La que sobra es la más vieja: la página se queda con las 50 más nuevas.
  assert.ok(!oneMore.page.some((m) => m.id === 999));
});
