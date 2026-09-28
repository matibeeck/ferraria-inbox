import assert from "node:assert/strict";
import test from "node:test";

import {
  can,
  canAny,
  capabilitiesForRole,
  capabilitiesForRoles,
  isHotelRole,
  type Capability,
} from "./permissions.ts";

const TODAS_LAS_CAPACIDADES: Capability[] = [
  "verConversacionesHuespedes",
  "enviarMensajes",
  "verReservas",
  "verSolicitudes",
];

test("super_admin, manager y recepcionista conservan todo el inbox actual", () => {
  for (const role of ["super_admin", "manager", "recepcionista"]) {
    for (const cap of TODAS_LAS_CAPACIDADES) {
      assert.equal(can(role, cap), true, `${role} debería tener ${cap}`);
    }
  }
});

test("historial y queja reciente: por ahora SOLO super_admin", () => {
  assert.equal(can("super_admin", "verHistorialConversacion"), true);
  for (const role of ["manager", "recepcionista", "operativo", null, "", "superadmin", "Super_admin"]) {
    assert.equal(can(role, "verHistorialConversacion"), false, `${String(role)} no debería tenerla`);
  }
  // La unión de membresías no la regala: solo aparece con un super_admin real.
  assert.equal(canAny(["manager", "recepcionista"], "verHistorialConversacion"), false);
  assert.equal(canAny(["recepcionista", "super_admin"], "verHistorialConversacion"), true);
});

test("operativo SOLO ve Solicitudes", () => {
  assert.equal(can("operativo", "verSolicitudes"), true);
  assert.equal(can("operativo", "verConversacionesHuespedes"), false);
  assert.equal(can("operativo", "enviarMensajes"), false);
  assert.equal(can("operativo", "verReservas"), false);
});

/**
 * EL TEST IMPORTANTE DE LA TANDA. Antes de la matriz, un rol desconocido caía en
 * "miembro normal con acceso total". Si esto se rompe, un typo en `hotel_users`
 * vuelve a abrir la bandeja de huéspedes.
 */
test("rol desconocido, nulo o con typo → CERO capacidades", () => {
  const entradasInvalidas: unknown[] = [
    null,
    undefined,
    "",
    "   ",
    "operativo ", // se normaliza con trim, pero ojo: este SÍ es válido (ver test aparte)
    "mantenimiento", // typo plausible: el área, no el rol
    "housekeeping",
    "Operativo", // mayúscula: NO es el literal de la base
    "OPERATIVO",
    "superadmin", // sin guion bajo
    "super-admin",
    "admin",
    "recepcionist", // typo
    "constructor", // prototipo: no debe resolver a nada
    "__proto__",
    "toString",
    0,
    1,
    true,
    false,
    {},
    [],
    { role: "super_admin" },
  ];

  for (const entrada of entradasInvalidas) {
    if (entrada === "operativo ") continue; // cubierto abajo
    for (const cap of TODAS_LAS_CAPACIDADES) {
      assert.equal(
        can(entrada, cap),
        false,
        `${JSON.stringify(entrada)} no debería tener ${cap}`
      );
    }
  }
});

test("el rol se normaliza con trim (espacios sobrantes en la base no rompen el gate)", () => {
  assert.equal(can(" operativo ", "verSolicitudes"), true);
  assert.equal(can(" operativo ", "verConversacionesHuespedes"), false);
  assert.equal(can("  recepcionista", "verConversacionesHuespedes"), true);
});

test("isHotelRole reconoce solo el vocabulario de la base", () => {
  assert.equal(isHotelRole("super_admin"), true);
  assert.equal(isHotelRole("manager"), true);
  assert.equal(isHotelRole("recepcionista"), true);
  assert.equal(isHotelRole("operativo"), true);
  assert.equal(isHotelRole("Operativo"), false);
  assert.equal(isHotelRole(null), false);
  assert.equal(isHotelRole(undefined), false);
  assert.equal(isHotelRole(""), false);
});

test("capabilitiesForRole devuelve el mapa completo, nunca undefined", () => {
  const caps = capabilitiesForRole("no-existe");
  for (const cap of TODAS_LAS_CAPACIDADES) {
    assert.equal(caps[cap], false);
  }
});

test("sin membresías no hay capacidades", () => {
  const caps = capabilitiesForRoles([]);
  for (const cap of TODAS_LAS_CAPACIDADES) {
    assert.equal(caps[cap], false);
  }
});

test("la unión entre membresías conserva el acceso del rol más amplio", () => {
  // Operativo en un hotel, recepcionista en otro: conserva conversaciones.
  // El recorte por hotel lo hace resolveGuestDataHotelIds, no la matriz.
  assert.equal(canAny(["operativo", "recepcionista"], "verConversacionesHuespedes"), true);
  assert.equal(canAny(["operativo", "recepcionista"], "verSolicitudes"), true);
});

test("la unión NO se deja ampliar por roles basura", () => {
  assert.equal(canAny(["operativo", "mantenimiento"], "verConversacionesHuespedes"), false);
  assert.equal(canAny(["operativo", null, "", "typo"], "verConversacionesHuespedes"), false);
  assert.equal(canAny([null, undefined], "verSolicitudes"), false);
});

test("solo operativos: cero acceso a datos de huéspedes", () => {
  const caps = capabilitiesForRoles(["operativo", "operativo"]);
  assert.equal(caps.verConversacionesHuespedes, false);
  assert.equal(caps.enviarMensajes, false);
  assert.equal(caps.verReservas, false);
  assert.equal(caps.verSolicitudes, true);
  assert.equal(caps.verHistorialConversacion, false);
});
