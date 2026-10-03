import type { ReservaStatus } from "@/lib/reservas-estado";

export type { ReservaStatus };
export type ReservasTab = "pendientes" | "procesadas" | "archivadas";

export type ReservaQuoteRequest = {
  id: string;
  sender_phone: string | null;
  guest_name: string | null;
  guest_email: string | null;
  fecha_entrada: string | null;
  fecha_salida: string | null;
  nights: number | null;
  num_rooms: number | null;
  room_type_requested: string | null;
  adults: number | null;
  children: number | null;
  pets: boolean | null;
  breakfast_included: boolean | null;
  total_amount: number | string | null;
  breakdown_json: Record<string, unknown> | null;
  conversation_id: string | null;
};

export type Reserva = {
  id: string;
  hotel_id: string;
  quote_request_id: string;
  conversation_id: string | null;
  titular_nombre: string;
  cedula: string;
  correo: string;
  notas: string | null;
  /**
   * Lo escriben el Inbox y el engine: puede llegar un valor que este código no
   * conoce. Se pinta siempre con `presentacionEstado`, que no revienta.
   */
  status: ReservaStatus | (string & {});
  rejection_reason: string | null;
  created_at: string;
  completed_at: string | null;
  processed_by: string | null;
  quote_requests: ReservaQuoteRequest | null;
  /** Solo en reemplazadas, y solo cuando el engine ya la escribió. */
  replaced_by?: string | null;
  /**
   * La reserva que reemplazó a esta, resuelta en el servidor y SOLO si es del
   * mismo hotel. `null`: no existe o no es de este hotel → "Reemplazada" sin
   * enlace. Solo viene en la pestaña Archivadas.
   */
  reemplazo?: Reserva | null;
};

export type ReservasAvailableHotel = {
  id: string;
  name: string;
};

export type ReservasListResponse = {
  reservas?: Reserva[];
  count?: number;
  availableHotels?: ReservasAvailableHotel[];
  activeHotelId?: string | null;
  error?: string;
};

export type ReservaActionResponse = {
  ok: boolean;
  reserva?: Reserva;
  error?: string;
};
