import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  HISTORY_LIMIT,
  LABELS_TAXONOMY_VERSION,
  buildConversationHistory,
  formatEpisodeDate,
  markRecentComplaints,
  motivoLabel,
  recentComplaintConversationIds,
  recentComplaintsFor,
  resultadoLabel,
  type ConversationLabelRow,
} from "./conversation-labels.ts";
import { capabilitiesForRole } from "./permissions.ts";

const DIA = 24 * 60 * 60 * 1000;
/** 2026-09-29 12:00 hora Colombia (17:00 UTC). */
const AHORA = Date.parse("2026-09-29T17:00:00Z");

function haceDias(dias: number): string {
  return new Date(AHORA - dias * DIA).toISOString();
}

function queja(overrides: Partial<ConversationLabelRow> = {}): ConversationLabelRow {
  return {
    conversation_id: "c-1",
    motivo: "servicio_estadia",
    resultado: "atendido_humano",
    queja: true,
    episode_started_at: haceDias(2),
    episode_ended_at: haceDias(1),
    ...overrides,
  };
}

test("una queja reciente de un tramo con pedido real enciende el badge", () => {
  const ids = recentComplaintConversationIds([queja()], AHORA);
  assert.deepEqual([...ids], ["c-1"]);
});

test("la queja de un tramo sin_contenido NO enciende el badge", () => {
  const ids = recentComplaintConversationIds([queja({ motivo: "sin_contenido" })], AHORA);
  assert.equal(ids.size, 0);
});

test("tampoco cuentan las de iniciado_por_hotel ni spam_otro", () => {
  const ids = recentComplaintConversationIds(
    [
      queja({ conversation_id: "c-hotel", motivo: "iniciado_por_hotel" }),
      queja({ conversation_id: "c-spam", motivo: "spam_otro" }),
    ],
    AHORA
  );
  assert.equal(ids.size, 0);
});

test("una queja de hace 8 días NO enciende el badge", () => {
  const ids = recentComplaintConversationIds([queja({ episode_ended_at: haceDias(8) })], AHORA);
  assert.equal(ids.size, 0);
});

test("la ventana se mide por el CIERRE del tramo: empezó hace 9 días, cerró hace 6 → cuenta", () => {
  const ids = recentComplaintConversationIds(
    [queja({ episode_started_at: haceDias(9), episode_ended_at: haceDias(6) })],
    AHORA
  );
  assert.equal(ids.size, 1);
});

test("queja false, null o sin fecha de cierre legible → sin badge", () => {
  const ids = recentComplaintConversationIds(
    [
      queja({ conversation_id: "c-false", queja: false }),
      queja({ conversation_id: "c-null", queja: null }),
      queja({ conversation_id: "c-sin-fecha", episode_ended_at: null }),
      queja({ conversation_id: "c-basura", episode_ended_at: "ayer" }),
      queja({ conversation_id: "  " }),
    ],
    AHORA
  );
  assert.equal(ids.size, 0);
});

test("sin la capacidad la bandeja sale sin badges y la consulta ni se hace", async () => {
  let llamadas = 0;
  const cargar = async () => {
    llamadas += 1;
    return new Set(["c-1"]);
  };

  for (const role of ["manager", "recepcionista", "operativo", null]) {
    const ids = await recentComplaintsFor(capabilitiesForRole(role), cargar);
    assert.equal(ids.size, 0, `${String(role)} no debería ver el badge`);
  }
  assert.equal(llamadas, 0);

  const deSuperAdmin = await recentComplaintsFor(capabilitiesForRole("super_admin"), cargar);
  assert.deepEqual([...deSuperAdmin], ["c-1"]);
  assert.equal(llamadas, 1);
});

test("markRecentComplaints solo marca las conversaciones del conjunto", () => {
  const conversaciones: { id: string; recentComplaint?: boolean }[] = [{ id: "c-1" }, { id: "c-2" }];
  markRecentComplaints(conversaciones, new Set(["c-1"]));
  assert.equal(conversaciones[0]!.recentComplaint, true);
  assert.equal(conversaciones[1]!.recentComplaint, undefined);
});

test("historial: tope de 3 y del más reciente al más viejo", () => {
  const filas: ConversationLabelRow[] = [
    { motivo: "info_general", resultado: "resuelto_ia", episode_started_at: haceDias(20), episode_ended_at: haceDias(20) },
    { motivo: "cancelacion", resultado: "atendido_humano", episode_started_at: haceDias(3), episode_ended_at: haceDias(3) },
    { motivo: "cotizar_reserva_nueva", resultado: "reservo", episode_started_at: haceDias(1), episode_ended_at: haceDias(1) },
    { motivo: "pago_comprobante", resultado: "abandonado", episode_started_at: haceDias(10), episode_ended_at: haceDias(10) },
  ];
  const historial = buildConversationHistory(filas);
  assert.equal(HISTORY_LIMIT, 3);
  assert.equal(historial.length, 3);
  assert.deepEqual(
    historial.map((e) => e.motivo),
    ["Cotizar o reservar", "Cancelaciones", "Pagos y comprobantes"]
  );
  assert.deepEqual(
    historial.map((e) => e.resultado),
    ["Reservó", "Lo atendió recepción directamente", "El huésped dejó de responder"]
  );
});

test("historial: un tramo sin fecha legible queda al final, no arriba", () => {
  const historial = buildConversationHistory([
    { motivo: "info_general", episode_ended_at: null, episode_started_at: null },
    { motivo: "cancelacion", episode_ended_at: haceDias(40) },
  ]);
  assert.deepEqual(historial.map((e) => e.motivo), ["Cancelaciones", "Información general"]);
});

test("historial: la marca Queja sigue la misma regla que el badge", () => {
  const historial = buildConversationHistory([
    queja({ episode_ended_at: haceDias(1) }),
    queja({ motivo: "sin_contenido", episode_ended_at: haceDias(2) }),
    queja({ queja: false, episode_ended_at: haceDias(3) }),
  ]);
  assert.deepEqual(historial.map((e) => e.queja), [true, false, false]);
});

test("etiquetas: las del dashboard tal cual, y el código crudo si falta traducirlo", () => {
  assert.equal(motivoLabel("servicio_estadia"), "Servicios durante la estadía");
  assert.equal(resultadoLabel("escalado_ia"), "El agente lo pasó a recepción");
  assert.equal(motivoLabel("motivo_nuevo_del_engine"), "motivo_nuevo_del_engine");
  assert.equal(motivoLabel(null), "Sin clasificar");
  assert.equal(resultadoLabel("toString"), "toString");
});

test("fecha del tramo en hora Colombia, no en la del navegador", () => {
  // 2026-09-29 03:00 UTC = 2026-09-28 22:00 en Bogotá → "Ayer", no "Hoy".
  assert.equal(formatEpisodeDate("2026-09-29T03:00:00Z", AHORA), "Ayer");
  assert.equal(formatEpisodeDate("2026-09-29T14:00:00Z", AHORA), "Hoy");
  assert.equal(formatEpisodeDate("2026-09-24T15:00:00Z", AHORA), "24 de sept");
  assert.equal(formatEpisodeDate("2025-12-02T15:00:00Z", AHORA), "2 de dic de 2025");
  assert.equal(formatEpisodeDate(null, AHORA), null);
});

test("versión de la taxonomía: la misma del dashboard", () => {
  assert.equal(LABELS_TAXONOMY_VERSION, "v1.1");
});

test("las dos consultas filtran por hotel y versión en el query mismo", () => {
  const source = readFileSync(join(process.cwd(), "lib", "conversation-labels-server.ts"), "utf8");
  assert.equal(source.match(/\.eq\("hotel_id", hotelId\)/g)?.length, 2);
  assert.equal(source.match(/\.eq\("taxonomy_version", LABELS_TAXONOMY_VERSION\)/g)?.length, 2);
  assert.ok(source.includes(".limit(HISTORY_LIMIT)"));
});

test("el endpoint del historial valida la conversación y consulta con el hotel REAL de ella", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "api", "inbox", "conversation-history", "route.ts"),
    "utf8"
  );
  assert.ok(source.includes("assertConversationInHotel(supabase, conversationId, gate.allowedHotelIds)"));
  assert.ok(source.includes("fetchConversationHistory(supabase, ownership.hotelId, conversationId)"));
  // El cliente no elige el hotel: el endpoint no lee ningún `hotelId` de la URL.
  assert.ok(!source.includes('get("hotelId")'));
});
