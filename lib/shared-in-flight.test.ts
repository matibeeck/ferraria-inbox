import assert from "node:assert/strict";
import test from "node:test";

import { createInFlightSharer } from "./shared-in-flight.ts";

test("dos llamadas simultáneas con la misma clave hacen una sola petición", async () => {
  const share = createInFlightSharer();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return "ok";
  };

  const [a, b] = await Promise.all([share("me", run), share("me", run)]);
  assert.equal(a, "ok");
  assert.equal(b, "ok");
  assert.equal(calls, 1);
});

test("al terminar se suelta la clave: la siguiente llamada vuelve a pedir", async () => {
  const share = createInFlightSharer();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return calls;
  };

  assert.equal(await share("me", run), 1);
  assert.equal(await share("me", run), 2);
});

test("un fallo también suelta la clave y no queda pegado", async () => {
  const share = createInFlightSharer();
  let calls = 0;

  await assert.rejects(
    share("me", async () => {
      calls += 1;
      throw new Error("caído");
    })
  );
  assert.equal(
    await share("me", async () => {
      calls += 1;
      return "volvió";
    }),
    "volvió"
  );
  assert.equal(calls, 2);
});

test("claves distintas no se mezclan", async () => {
  const share = createInFlightSharer();
  let calls = 0;
  const run = async () => {
    calls += 1;
  };

  await Promise.all([share("a", run), share("b", run)]);
  assert.equal(calls, 2);
});
