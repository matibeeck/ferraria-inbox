/**
 * Campos de "la IA vuelve a esta conversación", hecho POR UNA PERSONA.
 *
 * `human_control_at` se limpia: es el reloj que usa el engine para saber hace
 * cuánto está muda una conversación y devolverle la IA sola a las ~2 h. Si no
 * se limpiara, el barrido creería que sigue apagada.
 *
 * `ai_reactivation_source: "manual"` es lo que permite distinguir esto de una
 * reactivación automática en la bandeja: sin este campo, la recepcionista no
 * podría saber si la IA volvió porque ella la devolvió o porque se venció el
 * plazo sin que nadie atendiera.
 *
 * `request: null` cierra la solicitud abierta con recepción ('pending' o
 * 'consult'): si una persona devuelve la IA, el tema quedó atendido. Sin esto
 * se acumulaban solicitudes 'pending' viejas con la IA activa.
 */
export function buildReactivateAiFields(now: string) {
  return {
    needs_human: false,
    ai_active: true,
    unread_count: 0,
    last_read_at: now,
    human_control_at: null,
    ai_reactivated_at: now,
    ai_reactivation_source: "manual",
    request: null,
  };
}
