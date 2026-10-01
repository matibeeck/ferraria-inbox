import assert from "node:assert/strict";
import test from "node:test";

import {
  avisoCierreActivado,
  avisoVisiblePara,
  CLAVE_AVISO_CIERRE,
  decidirAvisoCierre,
  habitacionParaMensaje,
  horaAvisoHuesped,
  mensajeAvisoParaRecepcion,
  MOTIVOS_SIN_AVISO,
  textoAvisoCierre,
  type EntradaAvisoCierre,
} from "./aviso-cierre.ts";

/**
 * Escenario base que SÍ avisa: ticket creado a las 10:00 hora Bogotá (15:00Z),
 * el huésped escribió a las 09:55 Bogotá y ahora son las 11:00 Bogotá.
 */
function entrada(partial: Partial<EntradaAvisoCierre> = {}): EntradaAvisoCierre {
  return {
    hacia: "resuelto",
    ticket: {
      categoria: "housekeeping",
      habitacion: "302",
      conversation_id: "c-1",
      created_at: "2026-09-30T15:00:00.123456+00:00",
    },
    settings: {},
    conversacion: { guestPhone: "573001112233", channel: "whatsapp", blocked: false },
    ultimoHumanoSalienteAt: null,
    ultimoEntranteColumnaAt: "2026-09-30T14:55:00+00:00",
    ultimoEntranteHiloAt: "2026-09-30T09:55:00",
    ahoraMs: Date.parse("2026-09-30T16:00:00Z"),
    ...partial,
  };
}

test("toggle: ausente, sin fila o con basura = ACTIVADO; solo false booleano lo apaga", () => {
  assert.equal(avisoCierreActivado(null), true);
  assert.equal(avisoCierreActivado(undefined), true);
  assert.equal(avisoCierreActivado({}), true);
  assert.equal(avisoCierreActivado([]), true);
  assert.equal(avisoCierreActivado({ [CLAVE_AVISO_CIERRE]: null }), true);
  assert.equal(avisoCierreActivado({ [CLAVE_AVISO_CIERRE]: "false" }), true);
  assert.equal(avisoCierreActivado({ [CLAVE_AVISO_CIERRE]: 0 }), true);
  assert.equal(avisoCierreActivado({ [CLAVE_AVISO_CIERRE]: true }), true);
  assert.equal(avisoCierreActivado({ [CLAVE_AVISO_CIERRE]: false }), false);
});

test("escenario base: se avisa con el texto de la categoría", () => {
  const d = decidirAvisoCierre(entrada());
  assert.deepEqual(d, {
    enviar: true,
    texto:
      "¡Listo! Tu solicitud de aseo y amenities en la habitación 302 ya fue atendida. Si necesitas algo más, escríbenos 😊",
  });
});

test("solo aplica al pasar a resuelto: tomar y cancelar no avisan", () => {
  assert.equal(decidirAvisoCierre(entrada({ hacia: "en_curso" })), null);
  assert.equal(decidirAvisoCierre(entrada({ hacia: "cancelado" })), null);
  assert.equal(decidirAvisoCierre(entrada({ hacia: "abierto" })), null);
});

test("settings sin la clave (hotel sin configurar) avisa igual", () => {
  assert.equal(decidirAvisoCierre(entrada({ settings: null }))?.enviar, true);
  assert.equal(decidirAvisoCierre(entrada({ settings: { otra_cosa: 1 } }))?.enviar, true);
});

test("desactivado_hotel manda sobre todo lo demás", () => {
  const d = decidirAvisoCierre(
    entrada({ settings: { [CLAVE_AVISO_CIERRE]: false }, ticket: { ...entrada().ticket, conversation_id: null } })
  );
  assert.deepEqual(d, { enviar: false, motivo: "desactivado_hotel" });
});

test("sin_conversacion: ticket sin conversation_id, conversación no encontrada o sin teléfono", () => {
  const sinId = entrada({ ticket: { ...entrada().ticket, conversation_id: null } });
  assert.deepEqual(decidirAvisoCierre(sinId), { enviar: false, motivo: "sin_conversacion" });

  const vacio = entrada({ ticket: { ...entrada().ticket, conversation_id: "  " } });
  assert.deepEqual(decidirAvisoCierre(vacio), { enviar: false, motivo: "sin_conversacion" });

  assert.deepEqual(decidirAvisoCierre(entrada({ conversacion: null })), {
    enviar: false,
    motivo: "sin_conversacion",
  });
  assert.deepEqual(
    decidirAvisoCierre(entrada({ conversacion: { guestPhone: "", channel: "whatsapp", blocked: false } })),
    { enviar: false, motivo: "sin_conversacion" }
  );
});

test("no_verificado: si una lectura falló no se manda", () => {
  assert.deepEqual(decidirAvisoCierre(entrada({ verificacionFallida: true })), {
    enviar: false,
    motivo: "no_verificado",
  });
});

test("no_verificado: fecha del ticket ilegible, no hay contra qué comparar", () => {
  const d = decidirAvisoCierre(entrada({ ticket: { ...entrada().ticket, created_at: "basura" } }));
  assert.deepEqual(d, { enviar: false, motivo: "no_verificado" });
});

test("canal_no_whatsapp: los hilos de OTA no reciben el aviso", () => {
  for (const channel of ["booking", "expedia", "airbnb", " Booking "]) {
    const d = decidirAvisoCierre(
      entrada({ conversacion: { guestPhone: "uuid-del-hilo", channel, blocked: false } })
    );
    assert.deepEqual(d, { enviar: false, motivo: "canal_no_whatsapp" }, channel);
  }
  // Canal nulo o desconocido = WhatsApp, como en el resto del inbox.
  for (const channel of [null, "", "telegram"]) {
    const d = decidirAvisoCierre(entrada({ conversacion: { guestPhone: "573001112233", channel, blocked: false } }));
    assert.equal(d?.enviar, true, String(channel));
  }
});

test("conversacion_bloqueada: no se le escribe a un contacto bloqueado", () => {
  const d = decidirAvisoCierre(
    entrada({ conversacion: { guestPhone: "573001112233", channel: "whatsapp", blocked: true } })
  );
  assert.deepEqual(d, { enviar: false, motivo: "conversacion_bloqueada" });
});

test("ya_le_escribieron: mensaje humano DESPUÉS de crearse el ticket", () => {
  // 10:05 Bogotá = 15:05Z, cinco minutos después del ticket.
  const d = decidirAvisoCierre(entrada({ ultimoHumanoSalienteAt: "2026-09-30T10:05:00" }));
  assert.deepEqual(d, { enviar: false, motivo: "ya_le_escribieron" });
});

test("un mensaje humano ANTERIOR al ticket no frena el aviso", () => {
  // 09:30 Bogotá = 14:30Z, media hora antes del ticket.
  const d = decidirAvisoCierre(entrada({ ultimoHumanoSalienteAt: "2026-09-30 09:30:00" }));
  assert.equal(d?.enviar, true);
});

test("zona horaria: el texto sin zona de Wubby es hora Bogotá, no UTC", () => {
  // Ticket 15:00Z. Humano a las 12:00 SIN zona = 17:00Z (después del ticket).
  // Leído ingenuamente como UTC serían las 12:00Z, ANTES del ticket, y el
  // aviso saldría duplicado encima de lo que recepción ya escribió.
  const despues = decidirAvisoCierre(entrada({ ultimoHumanoSalienteAt: "2026-09-30T12:00:00" }));
  assert.deepEqual(despues, { enviar: false, motivo: "ya_le_escribieron" });

  // Borde exacto: 10:00:01 Bogotá es un segundo DESPUÉS del ticket (15:00Z) y
  // 09:59:59 Bogotá un segundo ANTES.
  const borde = decidirAvisoCierre(entrada({ ultimoHumanoSalienteAt: "2026-09-30T10:00:01" }));
  assert.deepEqual(borde, { enviar: false, motivo: "ya_le_escribieron" });
  const antes = decidirAvisoCierre(entrada({ ultimoHumanoSalienteAt: "2026-09-30T09:59:59" }));
  assert.equal(antes?.enviar, true);
});

test("zona horaria: ticket con offset y Wubby sin zona en el mismo instante no cuenta como 'después'", () => {
  const d = decidirAvisoCierre(
    entrada({
      ticket: { ...entrada().ticket, created_at: "2026-09-30T15:00:00+00:00" },
      ultimoHumanoSalienteAt: "2026-09-30T10:00:00",
    })
  );
  assert.equal(d?.enviar, true);
});

test("fuera_de_ventana: último entrante hace más de 24 h", () => {
  const ahoraMs = Date.parse("2026-10-01T16:00:00Z");
  const d = decidirAvisoCierre(
    entrada({
      ahoraMs,
      ultimoEntranteColumnaAt: "2026-09-30T15:59:00+00:00",
      ultimoEntranteHiloAt: "2026-09-30T10:59:00",
    })
  );
  assert.deepEqual(d, { enviar: false, motivo: "fuera_de_ventana" });
});

test("fuera_de_ventana: sin ningún entrante conocido no hay ventana", () => {
  const d = decidirAvisoCierre(entrada({ ultimoEntranteColumnaAt: null, ultimoEntranteHiloAt: null }));
  assert.deepEqual(d, { enviar: false, motivo: "fuera_de_ventana" });
});

test("ventana: se toma la fuente MÁS reciente, cualquiera de las dos rescata a la otra", () => {
  const ahoraMs = Date.parse("2026-10-01T16:00:00Z");
  // Columna vieja (25 h) pero el hilo tiene uno de hace 1 h (10:00 Bogotá = 15:00Z).
  const porHilo = decidirAvisoCierre(
    entrada({
      ahoraMs,
      ultimoEntranteColumnaAt: "2026-09-30T15:00:00+00:00",
      ultimoEntranteHiloAt: "2026-10-01T10:00:00",
    })
  );
  assert.equal(porHilo?.enviar, true);

  // Sin hilo, la columna sola alcanza.
  const porColumna = decidirAvisoCierre(
    entrada({ ahoraMs, ultimoEntranteColumnaAt: "2026-10-01T15:00:00+00:00", ultimoEntranteHiloAt: null })
  );
  assert.equal(porColumna?.enviar, true);
});

test("zona horaria en la ventana: 23 h reales con texto Bogotá siguen dentro", () => {
  // Ahora 2026-10-01 16:00Z. Entrante "2026-09-30T12:00:00" Bogotá = 17:00Z,
  // o sea hace 23 h: dentro. Leído como UTC serían 28 h y se saltaría el aviso.
  const d = decidirAvisoCierre(
    entrada({
      ahoraMs: Date.parse("2026-10-01T16:00:00Z"),
      ultimoEntranteColumnaAt: null,
      ultimoEntranteHiloAt: "2026-09-30T12:00:00",
    })
  );
  assert.equal(d?.enviar, true);
});

test("texto por categoría, sin habitación", () => {
  assert.equal(
    textoAvisoCierre("housekeeping", null),
    "¡Listo! Tu solicitud de aseo y amenities ya fue atendida. Si necesitas algo más, escríbenos 😊"
  );
  assert.equal(
    textoAvisoCierre("mantenimiento", null),
    "¡Listo! Tu reporte de mantenimiento ya fue atendido. Si algo sigue sin funcionar, cuéntanos 😊"
  );
  assert.equal(
    textoAvisoCierre("room_service", null),
    "¡Listo! Tu pedido ya fue atendido. Si necesitas algo más, escríbenos 😊"
  );
  assert.equal(
    textoAvisoCierre("otro", null),
    "¡Listo! Tu solicitud ya fue atendida. Si necesitas algo más, escríbenos 😊"
  );
});

test("categoría nula o desconocida cae al texto de 'otro'", () => {
  const otro = textoAvisoCierre("otro", null);
  assert.equal(textoAvisoCierre(null, null), otro);
  assert.equal(textoAvisoCierre("lavanderia", null), otro);
});

test("texto por categoría, con habitación", () => {
  assert.match(textoAvisoCierre("mantenimiento", "301"), /mantenimiento en la habitación 301 ya fue atendido\./);
  assert.match(textoAvisoCierre("room_service", "12B"), /Tu pedido a la habitación 12B ya fue atendido\./);
  assert.match(textoAvisoCierre("otro", " 405 "), /Tu solicitud de la habitación 405 ya fue atendida\./);
});

test("habitación dudosa no se mete en el mensaje", () => {
  assert.equal(habitacionParaMensaje("302"), "302");
  assert.equal(habitacionParaMensaje("A-12"), "A-12");
  assert.equal(habitacionParaMensaje(null), null);
  assert.equal(habitacionParaMensaje(""), null);
  assert.equal(habitacionParaMensaje("la del fondo"), null);
  assert.equal(habitacionParaMensaje("suite"), null);
  assert.equal(habitacionParaMensaje("123456789"), null);
  assert.equal(
    textoAvisoCierre("housekeeping", "no sé"),
    "¡Listo! Tu solicitud de aseo y amenities ya fue atendida. Si necesitas algo más, escríbenos 😊"
  );
});

test("copy para recepción: cada motivo tiene su frase, sin genéricos", () => {
  assert.equal(mensajeAvisoParaRecepcion({ enviado: true }), "Se le avisó al huésped");
  assert.equal(
    mensajeAvisoParaRecepcion({ enviado: false, motivo: "ya_le_escribieron" }),
    "No se avisó: recepción ya le escribió"
  );
  assert.equal(
    mensajeAvisoParaRecepcion({ enviado: false, motivo: "fuera_de_ventana" }),
    "No se avisó: pasaron más de 24 h desde su último mensaje"
  );
  assert.equal(
    mensajeAvisoParaRecepcion({ enviado: false, motivo: "desactivado_hotel" }),
    "No se avisó: el aviso está desactivado en este hotel"
  );
  for (const motivo of MOTIVOS_SIN_AVISO) {
    const texto = mensajeAvisoParaRecepcion({ enviado: false, motivo });
    assert.match(texto, /^No se avisó: /, motivo);
  }
});

test("hora del aviso en Bogotá, sin importar la zona del equipo", () => {
  assert.equal(horaAvisoHuesped("2026-09-30T19:05:00.000Z"), "14:05");
  assert.equal(horaAvisoHuesped("2026-09-30T04:30:00+00:00"), "23:30");
  assert.equal(horaAvisoHuesped(null), null);
  assert.equal(horaAvisoHuesped("basura"), null);
});

test("sin acceso a datos de huéspedes, el motivo no revela nada de la conversación", () => {
  assert.deepEqual(avisoVisiblePara({ enviado: true }, false), { enviado: true });
  for (const motivo of ["ya_le_escribieron", "fuera_de_ventana", "canal_no_whatsapp", "conversacion_bloqueada", "sin_conversacion", "no_verificado"] as const) {
    assert.deepEqual(avisoVisiblePara({ enviado: false, motivo }, false), { enviado: false }, motivo);
    assert.deepEqual(avisoVisiblePara({ enviado: false, motivo }, true), { enviado: false, motivo }, motivo);
  }
  assert.deepEqual(avisoVisiblePara({ enviado: false, motivo: "desactivado_hotel" }, false), {
    enviado: false,
    motivo: "desactivado_hotel",
  });
  assert.deepEqual(avisoVisiblePara({ enviado: false, motivo: "envio_fallido" }, false), {
    enviado: false,
    motivo: "envio_fallido",
  });
  assert.equal(mensajeAvisoParaRecepcion({ enviado: false }), "No se avisó al huésped");
});
