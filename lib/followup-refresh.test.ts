import assert from "node:assert/strict";
import { test } from "node:test";

import { followupReloadDelayMs } from "./followup-refresh.ts";

const DEBOUNCE = 5_000;
const GAP = 30_000;

test("sin carga previa, solo aplica el debounce", () => {
  const delay = followupReloadDelayMs({ nowMs: 100_000, lastLoadAtMs: 0, debounceMs: DEBOUNCE, minGapMs: GAP });
  assert.equal(delay, DEBOUNCE);
});

test("carga reciente: espera hasta completar el espacio mínimo", () => {
  const delay = followupReloadDelayMs({ nowMs: 110_000, lastLoadAtMs: 100_000, debounceMs: DEBOUNCE, minGapMs: GAP });
  assert.equal(delay, 20_000);
});

test("carga vieja: vuelve a mandar el debounce", () => {
  const delay = followupReloadDelayMs({ nowMs: 200_000, lastLoadAtMs: 100_000, debounceMs: DEBOUNCE, minGapMs: GAP });
  assert.equal(delay, DEBOUNCE);
});

test("nunca es menor que el debounce aunque falte poco para el espacio mínimo", () => {
  const delay = followupReloadDelayMs({ nowMs: 128_000, lastLoadAtMs: 100_000, debounceMs: DEBOUNCE, minGapMs: GAP });
  assert.equal(delay, DEBOUNCE);
});

test("una ráfaga sostenida no puede producir más de una recarga por espacio mínimo", () => {
  let now = 0;
  let lastLoad = 0;
  let loads = 0;
  // 10 minutos de eventos cada segundo; cada vez se recalcula el timer (debounce).
  // Igual que el hook: si ya hay una recarga programada, el evento nuevo no la
  // mueve (así una ráfaga sin pausas tampoco la deja sin disparar nunca).
  let pendingAt: number | null = null;
  for (now = 0; now <= 600_000; now += 1_000) {
    if (pendingAt !== null && now >= pendingAt) {
      loads += 1;
      lastLoad = now;
      pendingAt = null;
    }
    if (pendingAt === null) {
      pendingAt = now + followupReloadDelayMs({ nowMs: now, lastLoadAtMs: lastLoad, debounceMs: DEBOUNCE, minGapMs: GAP });
    }
  }
  assert.ok(loads <= Math.ceil(600_000 / GAP) + 1, `demasiadas recargas: ${loads}`);
  assert.ok(loads >= Math.floor(600_000 / (GAP + DEBOUNCE)) - 1, `se quedó sin recargar: ${loads}`);
});
