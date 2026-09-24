import assert from "node:assert/strict";
import test from "node:test";

import { LIST_PREVIEW_MAX_CHARS, truncateListPreview } from "./inbox-preview.ts";

test("un preview corto sale intacto", () => {
  assert.equal(truncateListPreview("Hola, ¿tienen parqueadero?"), "Hola, ¿tienen parqueadero?");
});

test("justo en el tope no se corta", () => {
  const exact = "a".repeat(LIST_PREVIEW_MAX_CHARS);
  assert.equal(truncateListPreview(exact), exact);
});

test("un mensaje largo sale con a lo sumo 120 caracteres, elipsis incluida", () => {
  const long = "b".repeat(5000);
  const out = truncateListPreview(long);
  assert.ok(out.length <= LIST_PREVIEW_MAX_CHARS);
  assert.ok(out.endsWith("…"));
  // Mismo corte que tenía la fila antes de extraer la función: 117 + "…".
  assert.equal(out, `${"b".repeat(LIST_PREVIEW_MAX_CHARS - 3)}…`);
});
