import assert from "node:assert/strict";
import test from "node:test";

import {
  handoffReasonLabel,
  isConsultMode,
  needsReceptionAttention,
  type HandoffStateInput,
} from "./handoff-state.ts";

function conv(over: Partial<HandoffStateInput> = {}): HandoffStateInput {
  return {
    request: null,
    needsHuman: false,
    aiActive: true,
    blocked: false,
    dbStatus: "open",
    operationalStatus: "ai_active",
    ...over,
  };
}

test("consulta (solicitud pendiente con la IA activa) entra en Atención", () => {
  const c = conv({ request: "pending" });
  assert.equal(isConsultMode(c), true);
  assert.equal(needsReceptionAttention(c), true);
});

test("pausa total sigue en Atención y NO se marca como consulta", () => {
  const c = conv({ request: "pending", needsHuman: true, operationalStatus: "requires_attention" });
  assert.equal(needsReceptionAttention(c), true);
  assert.equal(isConsultMode(c), false);
});

test("IA apagada, control humano o bloqueo no son consulta aunque haya solicitud", () => {
  assert.equal(isConsultMode(conv({ request: "pending", aiActive: false, operationalStatus: "requires_attention" })), false);
  assert.equal(isConsultMode(conv({ request: "pending", dbStatus: "human_control", operationalStatus: "requires_attention" })), false);
  assert.equal(isConsultMode(conv({ request: "pending", blocked: true, operationalStatus: "requires_attention" })), false);
});

test("sin solicitud y con la IA activa NO entra en Atención (como hoy)", () => {
  assert.equal(needsReceptionAttention(conv()), false);
  assert.equal(needsReceptionAttention(conv({ request: "resolved" })), false);
});

test("una conversación cerrada no entra en Atención aunque la solicitud siga pendiente", () => {
  const c = conv({ request: "pending", dbStatus: "completed", operationalStatus: "closed" });
  assert.equal(needsReceptionAttention(c), false);
  assert.equal(isConsultMode(c), false);
});

test("los motivos conocidos del engine salen cortos", () => {
  assert.equal(handoffReasonLabel("El huésped envió un archivo"), "Envió un archivo");
  assert.equal(handoffReasonLabel("Consulta de tarifas que la IA no pudo resolver"), "Cotización para revisar");
  assert.equal(
    handoffReasonLabel("El huésped pide un artículo o servicio que no está documentado: confirmar si el hotel lo ofrece"),
    "Confirmar si el hotel ofrece lo que pide",
  );
});

test("un motivo desconocido se muestra tal cual y uno vacío no se muestra", () => {
  assert.equal(handoffReasonLabel("motivo_nuevo_del_engine"), "motivo_nuevo_del_engine");
  assert.equal(handoffReasonLabel("  "), null);
  assert.equal(handoffReasonLabel(null), null);
  assert.equal(handoffReasonLabel(undefined), null);
});
