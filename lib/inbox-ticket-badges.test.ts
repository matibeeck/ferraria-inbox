import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTicketBadges,
  buildTicketBadgesByConversation,
  ticketBadgeAriaLabel,
  ticketBadgeText,
  type InboxTicketBadge,
  type TicketBadgeRow,
} from "./inbox-ticket-badges.ts";

function row(partial: Partial<TicketBadgeRow> & { id: string }): TicketBadgeRow {
  return {
    conversation_id: "c-1",
    categoria: "housekeeping",
    habitacion: "302",
    estado: "abierto",
    created_at: "2026-09-16T10:00:00",
    ...partial,
  };
}

test("agrupa por conversación y se queda con la más reciente", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", categoria: "mantenimiento", created_at: "2026-09-16T08:00:00" }),
    row({ id: "t-2", categoria: "room_service", created_at: "2026-09-16T11:00:00", habitacion: "415" }),
    row({ id: "t-3", categoria: "housekeeping", created_at: "2026-09-16T09:00:00" }),
  ]);

  assert.equal(badges.size, 1);
  const badge = badges.get("c-1")!;
  assert.equal(badge.categoria, "room_service");
  assert.equal(badge.habitacion, "415");
  assert.equal(badge.extraCount, 2);
});

test("cuenta solo las pendientes: resuelta y cancelada no existen para el badge", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", estado: "resuelto" }),
    row({ id: "t-2", estado: "cancelado" }),
    row({ id: "t-3", estado: "en_curso", created_at: "2026-09-16T12:00:00" }),
  ]);

  const badge = badges.get("c-1")!;
  assert.equal(badge.enCurso, true);
  assert.equal(badge.extraCount, 0);
});

test("una conversación sin solicitudes pendientes no aparece en el mapa", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", estado: "resuelto" }),
    row({ id: "t-2", estado: "cancelado" }),
  ]);

  assert.equal(badges.size, 0);
});

test("ticket sin conversation_id se ignora en vez de romper el mapa", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", conversation_id: null }),
    row({ id: "t-2", conversation_id: "   " }),
  ]);

  assert.equal(badges.size, 0);
});

test("categoría desconocida o nula cae en 'Solicitud', no en 'Otro'", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", categoria: "spa" }),
    row({ id: "t-2", conversation_id: "c-2", categoria: null }),
  ]);

  assert.equal(badges.get("c-1")!.label, "Solicitud");
  assert.equal(badges.get("c-2")!.label, "Solicitud");
});

test("fecha ilegible no gana el desempate de 'la más reciente'", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", categoria: "mantenimiento", created_at: "2026-09-16T08:00:00" }),
    row({ id: "t-2", categoria: "room_service", created_at: "no es una fecha" }),
  ]);

  assert.equal(badges.get("c-1")!.categoria, "mantenimiento");
});

test("habitación vacía o en blanco se omite del texto", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", habitacion: "   " }),
    row({ id: "t-2", conversation_id: "c-2", habitacion: null }),
  ]);

  assert.equal(ticketBadgeText(badges.get("c-1")!), "Housekeeping");
  assert.equal(ticketBadgeText(badges.get("c-2")!), "Housekeeping");
});

test("habitación larga se recorta en vez de empujar el renglón", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", habitacion: "la del fondo del segundo piso" }),
  ]);

  assert.equal(badges.get("c-1")!.habitacion, "la del fon…");
});

test("texto visible del badge", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", categoria: "mantenimiento", habitacion: "1203" }),
  ]);

  assert.equal(ticketBadgeText(badges.get("c-1")!), "Mantenimiento · Hab 1203");
});

test("el aria-label dice el estado y las otras solicitudes, que el texto no muestra", () => {
  const badges = buildTicketBadgesByConversation([
    row({ id: "t-1", estado: "en_curso", created_at: "2026-09-16T12:00:00" }),
    row({ id: "t-2", estado: "abierto", created_at: "2026-09-16T09:00:00" }),
  ]);

  assert.equal(
    ticketBadgeAriaLabel(badges.get("c-1")!),
    "Housekeeping, habitación 302, en curso, y 1 solicitud más"
  );
});

const BADGE: InboxTicketBadge = {
  categoria: "housekeeping",
  label: "Housekeeping",
  habitacion: "302",
  enCurso: false,
  extraCount: 0,
};

test("applyTicketBadges devuelve el MISMO array cuando nada cambió", () => {
  const conversations = [{ id: "c-1", ticketBadge: BADGE }];
  const next = applyTicketBadges(conversations, { "c-1": { ...BADGE } });
  assert.equal(next, conversations);
});

test("applyTicketBadges apaga el badge de la conversación que ya no lo tiene", () => {
  const conversations = [{ id: "c-1", ticketBadge: BADGE }];
  const next = applyTicketBadges(conversations, {});
  assert.notEqual(next, conversations);
  assert.equal(next[0]!.ticketBadge, null);
});

test("applyTicketBadges detecta el paso a 'en curso' sin cambiar nada más", () => {
  const conversations = [{ id: "c-1", ticketBadge: BADGE, unreadCount: 3 }];
  const next = applyTicketBadges(conversations, { "c-1": { ...BADGE, enCurso: true } });
  assert.equal(next[0]!.ticketBadge!.enCurso, true);
  assert.equal(next[0]!.unreadCount, 3);
});
