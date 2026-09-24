import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Auditoría estática de los Route Handlers.
 *
 * Los handlers corren con service_role y se saltan la RLS: el gate de capacidad
 * es el ÚNICO candado entre un `operativo` y los datos de huéspedes. Este test
 * lee cada `app/api/**\/route.ts`, parte el archivo por handler exportado y
 * exige que cada uno invoque el gate esperado.
 *
 * Una ruta nueva que no esté en la tabla hace fallar el test a propósito: hay
 * que decidir conscientemente qué capacidad exige antes de mergearla.
 */

const API_DIR = join(process.cwd(), "app", "api");

/**
 * ruta → método → marcador que debe aparecer en el cuerpo del handler.
 * `null` = exenta a propósito (ver motivo al lado).
 */
const ESPERADO: Record<string, Record<string, string | null>> = {
  "conversation-summary": { GET: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "conversations/[id]/block": { POST: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "conversations/[id]/unblock": { POST: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "conversations/[id]/message-statuses": { GET: 'capability: "verConversacionesHuespedes"' },
  "create-conversation-summary": { POST: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "followups/cancel": { POST: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "inbox": {
    GET: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")',
    PATCH: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")',
  },
  "inbox/messages": { GET: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "inbox/ticket-badges": { GET: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "inbox/message-by-temp-id": { GET: 'capability: "enviarMensajes"' },
  "media/signed-url": { GET: 'requireCapability(supabase, auth.user, "verConversacionesHuespedes")' },
  "message-templates": { GET: 'requireCapability(supabase, auth.user, "enviarMensajes")' },
  "send-human-message": { POST: 'capability: "enviarMensajes"' },
  "send-whatsapp-media": { POST: 'capability: "enviarMensajes"' },
  "send-whatsapp-template": { POST: 'requireCapability(supabase, auth.user, "enviarMensajes")' },
  // El GET pasa por `resolveReservasTenant`, que exige `verReservas` adentro.
  "reservas": {
    GET: "resolveReservasTenant(request, auth.user)",
    PATCH: 'requireCapability(supabase, auth.user, "verReservas")',
  },
  "reservas/messages": { GET: 'capability: "verReservas"' },
  "staff-contacts": {
    GET: 'capability: "verConversacionesHuespedes"',
    POST: 'capability: "verConversacionesHuespedes"',
  },
  "staff-contacts/[id]": { PATCH: 'capability: "verConversacionesHuespedes"' },
  "solicitudes": {
    GET: 'requireCapability(supabase, auth.user, "verSolicitudes")',
    PATCH: 'requireCapability(supabase, auth.user, "verSolicitudes")',
  },
  // Exentas a propósito: no leen ni escriben datos de huéspedes.
  "me": { GET: null }, // sus propias capacidades; el operativo la necesita para pintar el menú
  "feedback": { POST: null }, // escribe feedback del propio usuario
  "push/subscribe": { POST: null }, // su propia suscripción; la audiencia filtra al operativo
  "push/unsubscribe": { POST: null }, // borra solo filas con su user_id
  "push/notify": { POST: null }, // servidor a servidor, secreto compartido, sin sesión
};

function findRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findRoutes(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

/** Cuerpo de cada handler exportado: desde su `export` hasta el siguiente. */
function handlers(source: string): Record<string, string> {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  const hits = [...source.matchAll(re)];
  const out: Record<string, string> = {};
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    out[hit[1]] = source.slice(hit.index, end);
  });
  return out;
}

test("cada Route Handler tiene el gate de capacidad esperado", () => {
  const vistos = new Set<string>();

  for (const file of findRoutes(API_DIR)) {
    const ruta = relative(API_DIR, file).replace(/\/route\.ts$/, "").replace(/^route\.ts$/, "");
    vistos.add(ruta);
    const esperado = ESPERADO[ruta];
    assert.ok(esperado, `ruta sin clasificar: /api/${ruta} — agregala a ESPERADO con su capacidad`);

    const porMetodo = handlers(readFileSync(file, "utf8"));
    assert.deepEqual(
      Object.keys(porMetodo).sort(),
      Object.keys(esperado).sort(),
      `/api/${ruta}: los métodos exportados no coinciden con la tabla`
    );

    for (const [metodo, marcador] of Object.entries(esperado)) {
      if (marcador === null) continue;
      assert.ok(
        porMetodo[metodo].includes(marcador),
        `/api/${ruta} ${metodo}: falta el gate \`${marcador}\``
      );
    }
  }

  for (const ruta of Object.keys(ESPERADO)) {
    assert.ok(vistos.has(ruta), `ESPERADO nombra /api/${ruta}, que ya no existe`);
  }
});

test("reservas: el helper del GET exige verReservas", () => {
  const source = readFileSync(join(API_DIR, "reservas", "route.ts"), "utf8");
  assert.ok(source.includes('requireCapability(supabase, user, "verReservas")'));
});
