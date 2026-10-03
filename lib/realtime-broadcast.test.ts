import assert from "node:assert/strict";
import test from "node:test";

import { hotelRealtimeTopic, toRowChange } from "./realtime-broadcast.ts";

test("el topic del hotel es hotel:<id>, igual que el trigger", () => {
  assert.equal(
    hotelRealtimeTopic("dd99def1-daf4-4ca5-8dd9-149aa988394b"),
    "hotel:dd99def1-daf4-4ca5-8dd9-149aa988394b"
  );
});

test("INSERT: la fila nueva queda en new y old es null", () => {
  const out = toRowChange("INSERT", {
    table: "Wubby_Whatsapp",
    schema: "public",
    operation: "INSERT",
    record: { id: 7, hotel_id: "h1" },
    old_record: null,
  });
  assert.deepEqual(out, {
    table: "Wubby_Whatsapp",
    change: { eventType: "INSERT", new: { id: 7, hotel_id: "h1" }, old: null },
  });
});

test("UPDATE: trae fila nueva y vieja completas", () => {
  const out = toRowChange("UPDATE", {
    table: "conversations",
    record: { id: "c1", cotizacion: "si" },
    old_record: { id: "c1", cotizacion: null },
  });
  assert.equal(out?.table, "conversations");
  assert.deepEqual(out?.change.new, { id: "c1", cotizacion: "si" });
  assert.deepEqual(out?.change.old, { id: "c1", cotizacion: null });
});

test("DELETE: new es null y el id sale de old", () => {
  const out = toRowChange("DELETE", {
    table: "Wubby_Whatsapp",
    record: null,
    old_record: { id: 9 },
  });
  assert.equal(out?.change.new, null);
  assert.deepEqual(out?.change.old, { id: 9 });
});

test("un mensaje sin la forma de broadcast_changes se descarta", () => {
  assert.equal(toRowChange("INSERT", null), null);
  assert.equal(toRowChange("INSERT", "hola"), null);
  assert.equal(toRowChange("INSERT", { record: { id: 1 } }), null);
  assert.equal(toRowChange("INSERT", [1, 2]), null);
});

test("record que no es objeto queda en null, no revienta", () => {
  const out = toRowChange("UPDATE", { table: "conversations", record: "x", old_record: 3 });
  assert.equal(out?.change.new, null);
  assert.equal(out?.change.old, null);
});
