import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPendingReceiptWamids,
  mergeDeliveryReceipts,
  receiptsFromStatusRows,
  resolveDeliveryTick,
} from "./delivery-status.ts";
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

function full(wamid: string, status: MessageDeliveryReceipt["status"]): MessageDeliveryReceipt {
  return { wamid, status, errorCode: null, errorTitle: null };
}

test("filas de message_statuses: un acuse por wamid, el más avanzado, y los raros afuera", () => {
  const out = receiptsFromStatusRows([
    { wamid: "wamid.A", status: "sent", error_code: null, error_title: null },
    { wamid: "wamid.A", status: "read", error_code: null, error_title: null },
    { wamid: " wamid.B ", status: "failed", error_code: 131026, error_title: "Message Undeliverable" },
    { wamid: "wamid.C", status: "procesando", error_code: null, error_title: null },
    { wamid: null, status: "sent", error_code: null, error_title: null },
  ]);
  assert.deepEqual(
    out.sort((a, b) => a.wamid.localeCompare(b.wamid)),
    [
      full("wamid.A", "read"),
      { wamid: "wamid.B", status: "failed", errorCode: 131026, errorTitle: "Message Undeliverable" },
    ]
  );
});

test("merge de acuses: cada página suma y un acuse viejo no baja uno más avanzado", () => {
  const first = mergeDeliveryReceipts(new Map(), [full("wamid.A", "delivered"), full("wamid.B", "sent")]);
  assert.equal(first.size, 2);

  // Página de "cargar anteriores" con otro wamid + refetch tardío con `sent`.
  const next = mergeDeliveryReceipts(first, [full("wamid.C", "read"), full("wamid.A", "sent")]);
  assert.equal(next.size, 3);
  assert.equal(next.get("wamid.A")?.status, "delivered");
  assert.equal(next.get("wamid.C")?.status, "read");

  // El chip "No entregado" gana siempre.
  const failed = mergeDeliveryReceipts(next, [full("wamid.A", "failed")]);
  assert.equal(failed.get("wamid.A")?.status, "failed");
});

test("merge de acuses sin cambios devuelve el mismo mapa (sin re-render)", () => {
  const current = mergeDeliveryReceipts(new Map(), [full("wamid.A", "read")]);
  assert.equal(mergeDeliveryReceipts(current, []), current);
  assert.equal(mergeDeliveryReceipts(current, [full("wamid.A", "delivered")]), current);
});

test("refetch tras enviar: solo salientes que todavía pueden cambiar, los más nuevos primero", () => {
  const receipts = mergeDeliveryReceipts(new Map(), [
    full("wamid.OLD_READ", "read"),
    full("wamid.FAILED", "failed"),
    full("wamid.SENT", "sent"),
  ]);
  const messages = [
    { sender: "ai", wamid: "wamid.OLD_READ" },
    { sender: "user", wamid: "wamid.GUEST" },
    { sender: "agent", wamid: "wamid.FAILED" },
    { sender: "ai", wamid: "wamid.SENT" },
    { sender: "agent", wamid: "wamid.REACTION", reactionToWamid: "wamid.GUEST" },
    { sender: "agent", wamid: null },
    { sender: "agent", wamid: "wamid.JUST_SENT" },
  ];
  assert.deepEqual(collectPendingReceiptWamids(messages, receipts, 10), [
    "wamid.JUST_SENT",
    "wamid.SENT",
  ]);
  assert.deepEqual(collectPendingReceiptWamids(messages, receipts, 1), ["wamid.JUST_SENT"]);
});
