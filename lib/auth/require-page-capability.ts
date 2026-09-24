import { redirect } from "next/navigation";
import { getSessionUserCached } from "@/lib/auth/require-user";
import { pageRedirectFor } from "@/lib/auth/capability-gate";
import { resolveTenantContext } from "@/lib/inbox-tenant";
import type { Capability } from "@/lib/permissions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * Candado de servidor para las páginas: si el usuario no tiene la capacidad de
 * la pantalla, lo manda a su landing ANTES de que se renderice el client
 * component.
 *
 * Existe porque el rebote del `operativo` se movió del middleware al sidebar
 * (cliente), y un rebote de cliente no es un candado: la pantalla alcanza a
 * montarse. Los datos igual están protegidos por el gate de cada endpoint; esto
 * cierra la pantalla en sí.
 *
 * Reutiliza la sesión y la tenencia memoizadas por request
 * (`getSessionUserCached`, `resolveTenantContext`): si algo más en el mismo
 * render ya las pidió, no hay viaje nuevo.
 *
 * - Sin sesión: no hace nada. El middleware ya manda a `/login`, igual que hoy.
 * - Error de red al resolver sesión o tenencia: FALLA ABIERTO (renderiza), igual
 *   que el middleware. Cerrar acá dejaría a recepción sin bandeja por un parpadeo
 *   de la base, y abrir no expone datos: cada endpoint vuelve a verificar la
 *   capacidad y responde 403.
 */
export async function requirePageCapability(capability: Capability): Promise<void> {
  let destination: string | null = null;

  try {
    const user = await getSessionUserCached();
    if (!user) return;

    const tenant = await resolveTenantContext(getSupabaseServerClient(), user);
    destination = pageRedirectFor(tenant.capabilities, capability);
  } catch {
    console.warn("[page-gate] no se pudo resolver la sesión o la tenencia; se renderiza sin chequeo");
    return;
  }

  // `redirect()` lanza una excepción de control de Next: va FUERA del try para
  // que el catch de arriba no se la trague.
  if (destination) redirect(destination);
}
