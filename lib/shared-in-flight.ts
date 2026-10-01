/**
 * Junta llamadas simultáneas a la misma lectura en UNA sola petición.
 *
 * Mientras la promesa de `key` siga en vuelo, cualquier otra llamada con la
 * misma clave recibe esa misma promesa en vez de disparar otra. Apenas se
 * resuelve (bien o mal) la clave se suelta: la siguiente llamada vuelve a ir al
 * servidor. No es un caché: nunca devuelve un dato viejo, solo evita pedir dos
 * veces lo mismo en el mismo instante (p. ej. dos componentes que montan juntos).
 */
export function createInFlightSharer() {
  const inFlight = new Map<string, Promise<unknown>>();

  return function share<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        return await run();
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  };
}
