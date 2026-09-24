// `.js` explícito: `next` no declara `exports`, y así el módulo también carga
// con `node --test` (ESM puro) además de con el bundler de Next.
import { headers } from "next/headers.js";

/**
 * Memoiza un cálculo async UNA vez por request HTTP.
 *
 * Por qué no alcanza con `cache()` de React: en Route Handlers Next no monta el
 * dispatcher de caché de React, así que `cache(fn)` corre `fn` en cada llamada
 * (verificado en Next 16.2: la misma función envuelta corrió 3 de 3 veces en una
 * sola petición). `cache()` solo deduplica dentro de un render de Server
 * Components.
 *
 * Lo que sí es estable por request, tanto en Route Handlers como en Server
 * Components, es el objeto que devuelve `headers()`: mismo objeto en toda la
 * request, otro distinto en la siguiente. Se usa como llave de un WeakMap, así
 * que la memoria se libera sola cuando la request termina.
 *
 * Fuera de una request (tests con `node --test`, scripts) `headers()` tira y se
 * calcula sin memoizar: el comportamiento es el de siempre, solo que sin ahorro.
 *
 * Se guarda la PROMESA, no el valor: dos llamadas concurrentes comparten el
 * mismo viaje en vez de disparar dos. Si la promesa falla, falla para todos los
 * que la pidieron en esa request, igual que si cada uno la hubiera intentado.
 */
const scopes = new WeakMap<object, Map<string, Promise<unknown>>>();

async function currentRequestScope(): Promise<object | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

export async function memoPerRequest<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const scope = await currentRequestScope();
  if (!scope) return compute();

  let store = scopes.get(scope);
  if (!store) {
    store = new Map();
    scopes.set(scope, store);
  }

  const hit = store.get(key);
  if (hit) return hit as Promise<T>;

  const pending = compute();
  store.set(key, pending);
  return pending;
}
