import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { resolveTenantContext } from "../inbox-tenant.ts";
import { capabilitiesForRole, HOTEL_ROLES, type Capability } from "../permissions.ts";
import { INBOX_PATH, SOLICITUDES_PATH } from "../routes.ts";
import {
  CAPACIDADES_DE_HUESPED,
  decideCapability,
  decideRowOwnership,
  pageRedirectFor,
} from "./capability-gate.ts";

const TODAS: Capability[] = [
  "verConversacionesHuespedes",
  "enviarMensajes",
  "verReservas",
  "verSolicitudes",
  "verHistorialConversacion",
];

/**
 * Capacidades que hoy solo tiene super_admin (revisión de ~2 semanas). Cuando
 * se abran a manager y recepcionista, se sacan de acá y el test de "los demás
 * roles pasan" las vuelve a cubrir solo.
 */
const SOLO_SUPER_ADMIN: Capability[] = ["verHistorialConversacion"];

/** Cliente falso mínimo: `hotel_users` y `hotels`, nada más. */
function fakeSupabase(memberships: Array<{ hotel_id: string; role: string | null }>) {
  const hotels = [
    { id: "h-a", name: "Alfa", is_active: true, whatsapp_number: "573000000001" },
    { id: "h-b", name: "Beta", is_active: true, whatsapp_number: "573000000002" },
  ];
  function query(rows: unknown[]) {
    const result = Promise.resolve({ data: rows, error: null });
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        result.then(onOk, onErr),
    };
    return builder;
  }
  return {
    from(table: string) {
      if (table === "hotel_users") return query(memberships);
      if (table === "hotels") return query(hotels);
      throw new Error(`tabla inesperada: ${table}`);
    },
  } as unknown as SupabaseClient;
}

test("la matriz: operativo no tiene NINGUNA capacidad de datos de huéspedes", () => {
  const caps = capabilitiesForRole("operativo");
  for (const cap of CAPACIDADES_DE_HUESPED) {
    assert.equal(caps[cap], false, `operativo no debería tener ${cap}`);
  }
  // Lo único que le queda es Solicitudes.
  const suyas = TODAS.filter((cap) => caps[cap]);
  assert.deepEqual(suyas, ["verSolicitudes"]);
});

test("toda capacidad que no es Solicitudes cuenta como dato de huésped", () => {
  // Si mañana alguien agrega una capacidad nueva de huéspedes y olvida sumarla
  // al set, el recorte de hoteles quedaría en `allowedHotelIds` (sin filtrar).
  for (const cap of TODAS) {
    if (cap === "verSolicitudes") continue;
    assert.equal(CAPACIDADES_DE_HUESPED.has(cap), true, `${cap} debería estar en CAPACIDADES_DE_HUESPED`);
  }
});

test("gate de endpoint: operativo real (vía resolveTenantContext) es rechazado en todo lo de huéspedes", async () => {
  const tenant = await resolveTenantContext(
    fakeSupabase([{ hotel_id: "h-a", role: "operativo" }]),
    { id: "u-operativo-gate" } as User
  );
  for (const cap of CAPACIDADES_DE_HUESPED) {
    const decision = decideCapability(tenant, cap);
    assert.equal(decision.allowed, false, `${cap} debería dar 403 a un operativo`);
    assert.deepEqual(decision.hotelIds, []);
  }
  const solicitudes = decideCapability(tenant, "verSolicitudes");
  assert.equal(solicitudes.allowed, true);
  assert.deepEqual(solicitudes.hotelIds, ["h-a"]);
});

test("gate de endpoint: los demás roles pasan y recortan a sus hoteles de huéspedes", async () => {
  for (const role of HOTEL_ROLES.filter((r) => r !== "operativo" && r !== "super_admin")) {
    const tenant = await resolveTenantContext(
      fakeSupabase([{ hotel_id: "h-b", role }]),
      { id: `u-${role}-gate` } as User
    );
    for (const cap of CAPACIDADES_DE_HUESPED) {
      if (SOLO_SUPER_ADMIN.includes(cap)) continue;
      const decision = decideCapability(tenant, cap);
      assert.equal(decision.allowed, true, `${role} debería tener ${cap}`);
      assert.deepEqual(decision.hotelIds, ["h-b"]);
    }
  }
});

test("historial y queja reciente: sin la capacidad → 403 (todos menos super_admin)", async () => {
  for (const role of ["manager", "recepcionista", "operativo"]) {
    const tenant = await resolveTenantContext(
      fakeSupabase([{ hotel_id: "h-a", role }]),
      { id: `u-${role}-historial` } as User
    );
    const decision = decideCapability(tenant, "verHistorialConversacion");
    assert.equal(decision.allowed, false, `${role} no debería ver el historial`);
    assert.deepEqual(decision.hotelIds, []);
  }
});

test("historial: es dato de huésped, así que recorta a guestDataHotelIds", () => {
  assert.equal(CAPACIDADES_DE_HUESPED.has("verHistorialConversacion"), true);
  const decision = decideCapability(
    {
      capabilities: capabilitiesForRole("super_admin"),
      allowedHotelIds: ["h-a", "h-b"],
      guestDataHotelIds: ["h-a"],
    },
    "verHistorialConversacion"
  );
  assert.deepEqual(decision, { allowed: true, hotelIds: ["h-a"] });
});

test("aislamiento: una conversación de otro hotel → 403, aunque tenga la capacidad", () => {
  // El día que se abra a recepción, una recepcionista del hotel A pidiendo el
  // historial de una conversación del hotel B tiene que rebotar.
  const tenant = {
    capabilities: { ...capabilitiesForRole("recepcionista"), verHistorialConversacion: true },
    allowedHotelIds: ["h-a"],
    guestDataHotelIds: ["h-a"],
  };
  const gate = decideCapability(tenant, "verHistorialConversacion");
  assert.equal(gate.allowed, true);

  assert.deepEqual(decideRowOwnership({ hotel_id: "h-b" }, gate.hotelIds), { allowed: false, status: 403 });
  assert.deepEqual(decideRowOwnership({ hotel_id: null }, gate.hotelIds), { allowed: false, status: 403 });
  assert.deepEqual(decideRowOwnership(null, gate.hotelIds), { allowed: false, status: 404 });
  assert.deepEqual(decideRowOwnership({ hotel_id: " h-a " }, gate.hotelIds), {
    allowed: true,
    hotelId: "h-a",
  });
});

test("gate de endpoint: rol desconocido o null → rechazado en todo", async () => {
  for (const role of ["mantenimiento", null]) {
    const tenant = await resolveTenantContext(
      fakeSupabase([{ hotel_id: "h-a", role }]),
      { id: `u-${String(role)}-gate` } as User
    );
    for (const cap of TODAS) {
      assert.equal(decideCapability(tenant, cap).allowed, false, `${String(role)} no debería tener ${cap}`);
    }
  }
});

test("gate de página: operativo sale de la bandeja y de Reservas hacia Solicitudes", () => {
  const caps = capabilitiesForRole("operativo");
  assert.equal(pageRedirectFor(caps, "verConversacionesHuespedes"), SOLICITUDES_PATH);
  assert.equal(pageRedirectFor(caps, "verReservas"), SOLICITUDES_PATH);
});

test("gate de página: recepcionista no se redirige", () => {
  const caps = capabilitiesForRole("recepcionista");
  assert.equal(pageRedirectFor(caps, "verConversacionesHuespedes"), null);
  assert.equal(pageRedirectFor(caps, "verReservas"), null);
});

test("gate de página: sin bandeja, el destino nunca es la bandeja (no hay bucle)", () => {
  const caps = capabilitiesForRole(null);
  const destino = pageRedirectFor(caps, "verConversacionesHuespedes");
  assert.notEqual(destino, INBOX_PATH);
  assert.equal(destino, SOLICITUDES_PATH);
});
