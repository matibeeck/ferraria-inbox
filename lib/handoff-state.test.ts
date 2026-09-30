import assert from "node:assert/strict";
import test from "node:test";

import {
  handoffReasonLabel,
  hasOpenRequest,
  isConsultMode,
  needsReceptionAttention,
  type HandoffStateInput,
} from "./handoff-state.ts";
import { buildReactivateAiFields } from "./inbox-patch.ts";

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

test("consulta ('consult' con la IA activa) entra en Atención y se marca como consulta", () => {
  const c = conv({ request: "consult" });
  assert.equal(isConsultMode(c), true);
  assert.equal(needsReceptionAttention(c), true);
  assert.equal(hasOpenRequest(c), true);
});

test("'pending' con la IA activa (solicitud vieja) NO entra en Atención ni es consulta", () => {
  const c = conv({ request: "pending" });
  assert.equal(needsReceptionAttention(c), false);
  assert.equal(isConsultMode(c), false);
  // Sigue siendo solicitud abierta: "Asunto resuelto" y el motivo se muestran.
  assert.equal(hasOpenRequest(c), true);
});

test("'consult' con needs_human se ve como pausa total: Atención, pero no consulta", () => {
  const c = conv({ request: "consult", needsHuman: true, aiActive: false, operationalStatus: "requires_attention" });
  assert.equal(isConsultMode(c), false);
  assert.equal(needsReceptionAttention(c), true);
  // needs_human manda aunque ai_active siga en true.
  assert.equal(isConsultMode(conv({ request: "consult", needsHuman: true })), false);
});

test("pausa total ('pending' + needs_human) sigue en Atención y NO se marca como consulta", () => {
  const c = conv({ request: "pending", needsHuman: true, operationalStatus: "requires_attention" });
  assert.equal(needsReceptionAttention(c), true);
  assert.equal(isConsultMode(c), false);
});

test("IA apagada, control humano o bloqueo no son consulta aunque llegue 'consult'", () => {
  assert.equal(isConsultMode(conv({ request: "consult", aiActive: false, operationalStatus: "requires_attention" })), false);
  assert.equal(isConsultMode(conv({ request: "consult", dbStatus: "human_control", operationalStatus: "requires_attention" })), false);
  assert.equal(isConsultMode(conv({ request: "consult", blocked: true, operationalStatus: "requires_attention" })), false);
});

test("sin solicitud y con la IA activa NO entra en Atención (como hoy)", () => {
  assert.equal(needsReceptionAttention(conv()), false);
  assert.equal(needsReceptionAttention(conv({ request: "resolved" })), false);
  assert.equal(hasOpenRequest(conv({ request: "resolved" })), false);
});

test("una conversación cerrada no entra en Atención aunque la consulta siga abierta", () => {
  const c = conv({ request: "consult", dbStatus: "completed", operationalStatus: "closed" });
  assert.equal(needsReceptionAttention(c), false);
  assert.equal(isConsultMode(c), false);
});

test("reactivar la IA a mano cierra la solicitud (request null) y quita la pausa", () => {
  const fields = buildReactivateAiFields("2026-09-30T12:00:00.000Z");
  assert.equal(fields.request, null);
  assert.equal(fields.needs_human, false);
  assert.equal(fields.ai_active, true);
  assert.equal(fields.ai_reactivation_source, "manual");
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
