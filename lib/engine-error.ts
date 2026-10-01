/**
 * Lectura segura del error que devuelve ferraria-engine, para no mandarle al
 * navegador el cuerpo crudo de su respuesta.
 *
 * El crudo puede ser un stack del engine, una URL firmada de un archivo del
 * huésped o el payload de Meta con teléfonos adentro. Nada de eso puede
 * terminar en la pantalla de una recepcionista ni en los logs del servidor.
 *
 * `app/api/send-whatsapp-media` tiene su copia local de esta misma lógica desde
 * antes; queda para una limpieza aparte.
 */

/**
 * Borra cualquier URL del texto: las que viajan al engine son FIRMADAS y quien
 * las tenga puede bajar el archivo mientras no expiren.
 */
export function redactUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[url]");
}

/**
 * Mensaje del engine apto para mostrar. Prioriza `error`/`message`/`detail` del
 * JSON (incluido el anidado de Meta `{ error: { message } }`), que viene
 * curado. Si el cuerpo no es JSON o no trae ninguna de esas claves devuelve el
 * genérico que le pases.
 */
export function readEngineError(parsed: unknown, genericFallback: string): string {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return redactUrls(value.trim());
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) return redactUrls(nested.trim());
      }
    }
  }
  return genericFallback;
}
