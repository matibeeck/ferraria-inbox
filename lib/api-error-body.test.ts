import assert from "node:assert/strict";
import test from "node:test";

import { buildApiErrorBody, errorCodeForLog } from "./api-error-body.ts";

const supabaseError = {
  message: 'duplicate key value violates unique constraint "x"',
  code: "23505",
  details: "Key (guest_phone)=(573001112233) already exists.",
  hint: "algo",
};

test("en producción el cuerpo solo lleva el copy y el código", () => {
  const body = buildApiErrorBody("reservas_query_failed", "No se pudieron cargar las reservas", supabaseError, false);
  assert.deepEqual(body, { error: "No se pudieron cargar las reservas", code: "reservas_query_failed" });
});

test("en producción una excepción tampoco filtra su mensaje", () => {
  const body = buildApiErrorBody("unexpected", undefined, new Error("token=abc"), false);
  assert.equal(body.message, undefined);
  assert.ok(!JSON.stringify(body).includes("token"));
  assert.ok(body.error.length > 0);
});

test("en desarrollo agrega message, details y hint de la causa", () => {
  const body = buildApiErrorBody("x", "Copy", supabaseError, true);
  assert.equal(body.message, supabaseError.message);
  assert.equal(body.details, supabaseError.details);
  assert.equal(body.hint, supabaseError.hint);
});

test("en desarrollo una excepción expone su mensaje", () => {
  assert.equal(buildApiErrorBody("x", "Copy", new Error("boom"), true).message, "boom");
});

test("el log de producción solo lleva el código, nunca el mensaje", () => {
  assert.equal(errorCodeForLog(supabaseError), "23505");
  assert.equal(errorCodeForLog(new TypeError("573001112233")), "TypeError");
  assert.equal(errorCodeForLog("texto suelto"), "sin_code");
});
