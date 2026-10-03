import assert from "node:assert/strict";
import test from "node:test";

import {
  LABEL_ESTADO_DESCONOCIDO,
  RESERVA_ESTADOS,
  accionesPorEstado,
  esArchivada,
  presentacionEstado,
} from "./reservas-estado.ts";

test("los cinco estados conocidos tienen su etiqueta visible", () => {
  assert.equal(presentacionEstado("pendiente").label, "Pendiente");
  assert.equal(presentacionEstado("completada").label, "Procesada");
  assert.equal(presentacionEstado("rechazada").label, "Rechazada");
  assert.equal(presentacionEstado("reemplazada").label, "Reemplazada");
  assert.equal(presentacionEstado("cancelada").label, "Cancelada");
  for (const estado of RESERVA_ESTADOS) {
    assert.equal(presentacionEstado(estado).estado, estado);
  }
});

test("un estado desconocido muestra la etiqueta genérica y nunca lanza", () => {
  const raros: unknown[] = ["confirmada_pms", "", "PENDIENTE", null, undefined, 42, {}, ["pendiente"]];
  for (const valor of raros) {
    const p = presentacionEstado(valor);
    assert.equal(p.estado, null);
    assert.equal(p.label, LABEL_ESTADO_DESCONOCIDO);
    assert.equal(p.tono, "neutro");
  }
});

test("un estado desconocido no ofrece acciones que cambien la reserva", () => {
  assert.deepEqual(accionesPorEstado("confirmada_pms"), {
    completar: false,
    rechazar: false,
    volverAPendientes: false,
  });
  assert.deepEqual(accionesPorEstado(null).completar, false);
});

test("reemplazadas y canceladas no se completan ni se rechazan, solo se pueden revivir", () => {
  for (const estado of ["reemplazada", "cancelada"]) {
    assert.deepEqual(accionesPorEstado(estado), {
      completar: false,
      rechazar: false,
      volverAPendientes: true,
    });
    assert.equal(esArchivada(estado), true);
  }
});

test("pendientes y procesadas conservan sus acciones de siempre", () => {
  assert.deepEqual(accionesPorEstado("pendiente"), {
    completar: true,
    rechazar: true,
    volverAPendientes: false,
  });
  for (const estado of ["completada", "rechazada"]) {
    assert.deepEqual(accionesPorEstado(estado), {
      completar: false,
      rechazar: false,
      volverAPendientes: true,
    });
    assert.equal(esArchivada(estado), false);
  }
});
