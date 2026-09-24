import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { availableHotelsFrom, resolveTenantContext } from "./inbox-tenant.ts";

/**
 * Cliente falso que cuenta cuántas veces se consulta cada tabla y registra el
 * orden de inicio/fin, para comprobar que `hotel_users` y `hotels` viajan en
 * paralelo (las dos arrancan antes de que termine cualquiera).
 */
function fakeSupabase(memberships: Array<{ hotel_id: string; role: string | null }>) {
  const hotels = [
    { id: "h-a", name: "Alfa", is_active: true, whatsapp_number: "573000000001" },
    { id: "h-b", name: "Beta", is_active: false, whatsapp_number: "573000000002" },
    { id: "h-c", name: "Gamma", is_active: true, whatsapp_number: null },
  ];
  const calls: Record<string, number> = {};
  const timeline: string[] = [];

  function query(table: string, rows: unknown[]) {
    calls[table] = (calls[table] ?? 0) + 1;
    timeline.push(`start:${table}`);
    const result = new Promise((resolve) => {
      setTimeout(() => {
        timeline.push(`end:${table}`);
        resolve({ data: rows, error: null });
      }, 5);
    });
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        result.then(onOk, onErr),
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "hotel_users") return query(table, memberships);
      if (table === "hotels") return query(table, hotels);
      throw new Error(`tabla inesperada: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, calls, timeline };
}

const user = { id: "u-1" } as User;

test("recepcionista: 1 hotel_users + 1 hotels, en paralelo", async () => {
  const fake = fakeSupabase([{ hotel_id: "h-a", role: "recepcionista" }]);
  const tenant = await resolveTenantContext(fake.client, user);

  assert.deepEqual(fake.calls, { hotel_users: 1, hotels: 1 });
  assert.deepEqual(fake.timeline.slice(0, 2).sort(), ["start:hotel_users", "start:hotels"]);
  assert.deepEqual(tenant.allowedHotelIds, ["h-a"]);
  // El directorio completo NO se filtra hacia afuera: solo el hotel propio.
  assert.deepEqual(
    tenant.hotels.map((h) => h.id),
    ["h-a"]
  );
  assert.equal(tenant.hotels[0]!.whatsappNumber, "573000000001");
});

test("super_admin: ve todos los hoteles con la misma única lectura de hotels", async () => {
  const fake = fakeSupabase([{ hotel_id: "h-a", role: "super_admin" }]);
  const tenant = await resolveTenantContext(fake.client, user);

  assert.deepEqual(fake.calls, { hotel_users: 1, hotels: 1 });
  assert.deepEqual(tenant.allowedHotelIds, ["h-a", "h-b", "h-c"]);
  assert.deepEqual(tenant.guestDataHotelIds, ["h-a", "h-b", "h-c"]);
});

test("operativo: existe en el hotel pero no ve datos de huéspedes", async () => {
  const fake = fakeSupabase([{ hotel_id: "h-a", role: "operativo" }]);
  const tenant = await resolveTenantContext(fake.client, user);

  assert.deepEqual(tenant.allowedHotelIds, ["h-a"]);
  assert.deepEqual(tenant.guestDataHotelIds, []);
});

test("availableHotelsFrom: solo activos, dentro de la lista, orden por nombre y sin viajes", async () => {
  const fake = fakeSupabase([{ hotel_id: "h-a", role: "super_admin" }]);
  const tenant = await resolveTenantContext(fake.client, user);

  assert.deepEqual(availableHotelsFrom(tenant.hotels, ["h-c", "h-b", "h-a"]), [
    { id: "h-a", name: "Alfa" },
    { id: "h-c", name: "Gamma" },
  ]);
  assert.deepEqual(availableHotelsFrom(tenant.hotels, ["h-c"]), [{ id: "h-c", name: "Gamma" }]);
  assert.deepEqual(availableHotelsFrom(tenant.hotels, []), []);
  assert.deepEqual(fake.calls, { hotel_users: 1, hotels: 1 });
});
