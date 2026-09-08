import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeliveryTick } from "./delivery-status.ts";
import type { MessageDeliveryReceipt } from "./inbox-types.ts";

function receipt(status: MessageDeliveryReceipt["status"]): MessageDeliveryReceipt {
  return { wamid: "wamid.TEST", status } as MessageDeliveryReceipt;
}

test("sin acuse de Meta, el estado local manda", () => {
  assert.equal(resolveDeliveryTick("pending", undefined), "pending");
  assert.equal(resolveDeliveryTick("confirmed", undefined), "sent");
});

test("un fallo local nunca se pinta como enviado", () => {
  // La regresión que esto blinda: `failed` cayendo al `else` final y saliendo
  // como doble check, o sea recepción dando por entregado un mensaje que nunca
  // salió.
  assert.equal(resolveDeliveryTick("failed", undefined), "failed");
  assert.notEqual(resolveDeliveryTick("failed", undefined), "sent");
  assert.notEqual(resolveDeliveryTick("failed", undefined), "delivered");
});

test("el acuse de Meta le gana a cualquier estado local", () => {
  // Si Meta acusó algo hay `wamid`, y si hay `wamid` el mensaje sí salió: el
  // fallo local estaría desactualizado.
  assert.equal(resolveDeliveryTick("failed", receipt("delivered")), "delivered");
  assert.equal(resolveDeliveryTick("pending", receipt("read")), "read");
  assert.equal(resolveDeliveryTick("confirmed", receipt("failed")), "failed");
});
