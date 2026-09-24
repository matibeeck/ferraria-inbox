import { Suspense } from "react";
import { requirePageCapability } from "@/lib/auth/require-page-capability";
import InboxApp from "./components/InboxApp";
import { InboxLoadingSkeleton } from "./components/InboxLoadingSkeleton";

/**
 * El chequeo de capacidad corre en el servidor ANTES de montar la bandeja: un
 * `operativo` sale redirigido a Solicitudes sin ver la pantalla.
 *
 * El `Suspense` es obligatorio: `InboxApp` lee `?vista=staff` con
 * `useSearchParams` para saber si arranca en Huéspedes o en Staff, y sin límite
 * de suspensión eso arrastra toda la ruta a render en cliente.
 */
export default async function Home() {
  await requirePageCapability("verConversacionesHuespedes");
  return (
    <Suspense fallback={<InboxLoadingSkeleton />}>
      <InboxApp />
    </Suspense>
  );
}
