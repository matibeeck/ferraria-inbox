import assert from "node:assert/strict";
import test from "node:test";

import { interpretarRespuestaReactivarIa, resolverUrlReactivarIa } from "./engine-reactivate-ai.ts";

test("URL explícita gana", () => {
  assert.equal(
    resolverUrlReactivarIa({
      ENGINE_REACTIVATE_AI_URL: " https://engine.example.net/inbox/reactivate-ai ",
      ENGINE_HUMAN_REPLY_URL: "https://otro.example.net/inbox/human-reply",
    }),
    "https://engine.example.net/inbox/reactivate-ai"
  );
});

test("sin explícita, se deriva del origen de la de respuestas humanas", () => {
  assert.equal(
    resolverUrlReactivarIa({ ENGINE_HUMAN_REPLY_URL: "https://engine.example.net/inbox/human-reply?x=1#h" }),
    "https://engine.example.net/inbox/reactivate-ai"
  );
});

test("sin ninguna variable, o con basura, no hay URL", () => {
  assert.equal(resolverUrlReactivarIa({}), null);
  assert.equal(resolverUrlReactivarIa({ ENGINE_HUMAN_REPLY_URL: "no es una url" }), null);
});

test("200 con ok: hecho, con lo que pasó con lo pendiente", () => {
  assert.deepEqual(interpretarRespuestaReactivarIa(200, { ok: true, transitioned: true, replay: "queued" }), {
    ok: true,
    replay: "queued",
  });
  assert.deepEqual(interpretarRespuestaReactivarIa(200, { ok: true }), { ok: true, replay: null });
});

test("cualquier otra cosa: no hecho, y el PATCH escribe directo", () => {
  // Engine viejo sin el endpoint.
  assert.deepEqual(interpretarRespuestaReactivarIa(404, { message: "Route POST:/inbox/reactivate-ai not found" }), {
    ok: false,
    motivo: "404:sin_codigo",
  });
  // Hotel que sigue en n8n.
  assert.deepEqual(interpretarRespuestaReactivarIa(409, { error: "engine_disabled" }), {
    ok: false,
    motivo: "409:engine_disabled",
  });
  assert.deepEqual(interpretarRespuestaReactivarIa(500, null), { ok: false, motivo: "500:sin_codigo" });
  // Un 200 que no dice ok no cuenta.
  assert.deepEqual(interpretarRespuestaReactivarIa(200, { proxied: true }), { ok: false, motivo: "200:sin_codigo" });
});
