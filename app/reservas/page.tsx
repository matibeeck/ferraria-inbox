import { requirePageCapability } from "@/lib/auth/require-page-capability";
import { ReservasScreen } from "./ReservasScreen";

/**
 * Server component a propósito: el chequeo de capacidad corre en el servidor y
 * un `operativo` sale redirigido antes de que Reservas se monte. La pantalla
 * (cliente) vive en `ReservasScreen`.
 */
export default async function ReservasPage() {
  await requirePageCapability("verReservas");
  return <ReservasScreen />;
}
