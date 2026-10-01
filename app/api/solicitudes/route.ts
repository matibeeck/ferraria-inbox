import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  resolveActiveHotelId,
  resolveAvailableHotels,
  type HotelMembership,
} from "@/lib/inbox-tenant";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { avisoVisiblePara, type AvisoCierre } from "@/lib/aviso-cierre";
import { avisarCierreAlHuesped } from "@/lib/aviso-cierre-server";
import {
  esCambioRedundante,
  esTransicionValida,
  estadoDe,
  FILTRO_ESTADOS,
  isSolicitudesFiltro,
  isTicketEstado,
  motivoTransicionInvalida,
  normalizeArea,
  patchParaEstado,
  ESTADOS_PENDIENTES,
  SERVICE_TICKETS_TABLE,
  type ServiceTicket,
  type SolicitudesFiltro,
  type TicketArea,
} from "@/lib/service-tickets";

export const dynamic = "force-dynamic";

/**
 * Tope de filas por respuesta. Las pendientes de un hotel nunca se acercan a
 * esto; el tope existe por el historial de resueltas, que crece sin techo.
 * PostgREST corta en 1000 filas igual, así que pedir "todo" no es una opción.
 */
const MAX_FILAS = 200;

const TICKET_SELECT =
  "id, hotel_id, conversation_id, categoria, descripcion, habitacion, estado, created_at, en_curso_at, resuelto_at, cancelado_at, guest_notified_at";

/** Error genérico al cliente; el detalle real solo al log del servidor. */
function fallo(contexto: string, detalle: unknown, mensaje: string, status = 502) {
  console.error(`[solicitudes ${contexto}]`, detalle);
  return NextResponse.json({ error: mensaje }, { status });
}

/**
 * Categorías que este usuario puede ver EN ESTE HOTEL, o `null` si no tiene
 * recorte (recepción, manager, super_admin).
 *
 * El recorte se aplica solo cuando TODAS las membresías del usuario en ese hotel
 * son `operativo`. Si además es recepcionista en el mismo hotel, ve todo: el
 * permiso más amplio manda, igual que en `capabilitiesForRoles`.
 *
 * Un `operativo` con `area` nula o con typo cae en `otro` por `normalizeArea`.
 * Es a propósito: es exactamente la misma regla con la que C1 decide a quién le
 * llega el push del ticket. Si acá viera de más, recibiría notificaciones de un
 * área y una lista de otra, y ninguna de las dos sería confiable.
 */
function categoriasVisibles(
  memberships: readonly HotelMembership[],
  hotelId: string
): TicketArea[] | null {
  const delHotel = memberships.filter((m) => m.hotelId === hotelId);
  if (delHotel.length === 0) return null;

  const operativos = delHotel.filter((m) => m.role === "operativo");
  if (operativos.length !== delHotel.length) return null;

  const areas = new Set<TicketArea>();
  for (const m of operativos) {
    if (m.area === null || !isAreaConocida(m.area)) {
      console.warn("[solicitudes] operativo sin área reconocida: se limita a 'otro'", {
        hotel_id: hotelId,
        area_cruda: m.area,
      });
    }
    areas.add(normalizeArea(m.area));
  }
  return [...areas];
}

function isAreaConocida(raw: string): boolean {
  return normalizeArea(raw) === raw.trim().toLowerCase();
}

/** Un `super_admin` no se recorta por área en ningún hotel. */
function esSuperAdmin(memberships: readonly HotelMembership[]): boolean {
  return memberships.some((m) => m.role === "super_admin");
}

/**
 * Filtro PostgREST de categoría, o `null` si el usuario no tiene recorte.
 *
 * Se expresa siempre como `or(...)` —incluso para una sola categoría— para que
 * haya un único camino de código. El área `otro` arrastra además las filas con
 * `categoria` nula: si el engine no supo clasificar, el ticket existe igual y
 * alguien tiene que verlo, en vez de quedar invisible para todo el mundo.
 *
 * Los valores no se interpolan desde el request: salen de `normalizeArea`, que
 * solo devuelve literales de `TICKET_AREAS`.
 */
function filtroCategorias(categorias: TicketArea[] | null): string | null {
  if (!categorias || categorias.length === 0) return null;
  const partes = categorias.map((c) => `categoria.eq.${c}`);
  if (categorias.includes("otro")) partes.push("categoria.is.null");
  return partes.join(",");
}

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verSolicitudes");
    if (gate.response) return gate.response;

    const url = new URL(request.url);
    const soloConteo = url.searchParams.get("count") === "1";
    const filtroCrudo = url.searchParams.get("filtro");
    const filtro: SolicitudesFiltro = isSolicitudesFiltro(filtroCrudo)
      ? (filtroCrudo.trim() as SolicitudesFiltro)
      : "abiertas";

    const requestedHotelId = url.searchParams.get("hotelId")?.trim() ?? "";
    const availableHotels = await resolveAvailableHotels(supabase, gate.allowedHotelIds);
    const { activeHotelId, forbidden } = resolveActiveHotelId(
      requestedHotelId,
      gate.allowedHotelIds,
      availableHotels
    );

    if (forbidden) {
      return NextResponse.json({ error: "No autorizado para ver este hotel" }, { status: 403 });
    }
    if (!activeHotelId) {
      return NextResponse.json({
        solicitudes: [],
        count: 0,
        availableHotels,
        activeHotelId: null,
        puedeVerConversaciones: false,
      });
    }

    const { memberships, guestDataHotelIds } = gate.tenant;
    const categorias = esSuperAdmin(memberships)
      ? null
      : categoriasVisibles(memberships, activeHotelId);
    const puedeVerConversaciones = guestDataHotelIds.includes(activeHotelId);
    const orCategorias = filtroCategorias(categorias);

    if (soloConteo) {
      let conteo = supabase
        .from(SERVICE_TICKETS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", activeHotelId)
        .in("estado", [...ESTADOS_PENDIENTES]);
      if (orCategorias) conteo = conteo.or(orCategorias);

      const { count, error } = await conteo;
      if (error) {
        return fallo("count GET", error, "No se pudo contar las solicitudes");
      }
      return NextResponse.json({
        count: count ?? 0,
        availableHotels,
        activeHotelId,
        puedeVerConversaciones,
      });
    }

    let query = supabase
      .from(SERVICE_TICKETS_TABLE)
      .select(TICKET_SELECT)
      .eq("hotel_id", activeHotelId);

    const estados = FILTRO_ESTADOS[filtro];
    if (estados) {
      query = query.in("estado", [...estados]);
    }
    if (orCategorias) {
      query = query.or(orCategorias);
    }

    // Se pide lo más reciente primero para que el tope no corte historial nuevo;
    // el orden que ve el usuario (pendientes viejas arriba) lo pone la pantalla
    // con `ordenarTickets`, que es la misma regla testeada en `lib/`.
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(MAX_FILAS);

    if (error) {
      return fallo("GET", error, "No se pudo cargar las solicitudes");
    }

    const solicitudes = ((data ?? []) as unknown as ServiceTicket[]).map((row) => ({
      ...row,
      // Sin acceso a datos de huéspedes, el id de la conversación ni siquiera
      // sale del servidor: así el link al hilo no puede aparecer por un error de
      // la UI, porque no hay a dónde linkear.
      conversation_id: puedeVerConversaciones ? row.conversation_id : null,
    }));

    return NextResponse.json({
      solicitudes,
      count: solicitudes.filter((t) => ESTADOS_PENDIENTES.includes(estadoDe(t))).length,
      availableHotels,
      activeHotelId,
      puedeVerConversaciones,
    });
  } catch (e) {
    return fallo("GET", e, "No se pudo cargar las solicitudes", 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as { id?: string; estado?: string };
    const id = body.id?.trim();
    if (!id) {
      return NextResponse.json({ error: "id es obligatorio" }, { status: 400 });
    }

    const destinoCrudo = body.estado?.trim() ?? "";
    if (!isTicketEstado(destinoCrudo)) {
      return NextResponse.json({ error: "Estado desconocido" }, { status: 400 });
    }
    const destino = destinoCrudo as Parameters<typeof patchParaEstado>[0];

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verSolicitudes");
    if (gate.response) return gate.response;

    const { data: fila, error: errorLectura } = await supabase
      .from(SERVICE_TICKETS_TABLE)
      .select(TICKET_SELECT)
      .eq("id", id)
      .maybeSingle();

    if (errorLectura) {
      return fallo("PATCH lectura", errorLectura, "No se pudo leer la solicitud");
    }
    if (!fila) {
      return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
    }

    const actual = fila as unknown as ServiceTicket;
    const hotelId = actual.hotel_id != null ? String(actual.hotel_id).trim() : "";
    if (!hotelId || !gate.allowedHotelIds.includes(hotelId)) {
      return NextResponse.json({ error: "No autorizado para este hotel" }, { status: 403 });
    }

    // Mismo recorte de área que en el listado: un operativo de housekeeping no
    // puede cerrar por id un ticket de mantenimiento que nunca vio en pantalla.
    const { memberships, guestDataHotelIds } = gate.tenant;
    const categorias = esSuperAdmin(memberships) ? null : categoriasVisibles(memberships, hotelId);
    if (categorias && !categorias.includes(normalizeArea(actual.categoria))) {
      return NextResponse.json({ error: "No autorizado para esta solicitud" }, { status: 403 });
    }

    const puedeVerConversaciones = guestDataHotelIds.includes(hotelId);
    const desde = estadoDe(actual);

    if (esCambioRedundante(desde, destino)) {
      // Dos tablets tocando el mismo botón a la vez: la segunda no recibe un
      // error, recibe el estado que ya es correcto. No se re-estampa nada.
      return NextResponse.json({
        ok: true,
        sinCambios: true,
        solicitud: { ...actual, conversation_id: puedeVerConversaciones ? actual.conversation_id : null },
      });
    }

    if (!esTransicionValida(desde, destino)) {
      return NextResponse.json({ error: motivoTransicionInvalida(desde, destino) }, { status: 400 });
    }

    const ahora = new Date().toISOString();
    const { data, error } = await supabase
      .from(SERVICE_TICKETS_TABLE)
      .update(patchParaEstado(destino, { ahora, userId: auth.user.id }))
      .eq("id", id)
      .eq("hotel_id", hotelId)
      // Candado optimista: si alguien más la movió entre la lectura y el update,
      // no se pisa su cambio.
      .eq("estado", desde)
      .select(TICKET_SELECT)
      .maybeSingle();

    if (error) {
      return fallo("PATCH", error, "No se pudo actualizar la solicitud");
    }
    if (!data) {
      return NextResponse.json(
        { error: "Otra persona cambió esta solicitud. Actualiza la lista.", conflicto: true },
        { status: 409 }
      );
    }

    let actualizada = data as unknown as ServiceTicket;

    // Aviso al huésped: SOLO acá, después de un UPDATE efectivo a `resuelto`.
    // El camino idempotente y el 409 salen antes y nunca avisan, así que dos
    // tablets tocando "Resolver" a la vez no le mandan dos WhatsApp.
    // El cierre ya está guardado: el aviso no lo puede revertir ni tumbar.
    let aviso: AvisoCierre | undefined;
    if (destino === "resuelto") {
      const engineEnabled =
        gate.tenant.hotels.find((hotel) => hotel.id === hotelId)?.engineEnabled === true;
      const resultado = await avisarCierreAlHuesped({
        supabase,
        ticket: actualizada,
        hotelId,
        engineEnabled,
      });
      // Igual que con `conversation_id`: quien no ve datos de huéspedes no se
      // entera por el motivo de si recepción ya le escribió o cuándo escribió.
      aviso = avisoVisiblePara(resultado.aviso, puedeVerConversaciones);
      if (resultado.guestNotifiedAt) {
        actualizada = { ...actualizada, guest_notified_at: resultado.guestNotifiedAt };
      }
    }

    return NextResponse.json({
      ok: true,
      solicitud: {
        ...actualizada,
        conversation_id: puedeVerConversaciones ? actualizada.conversation_id : null,
      },
      ...(aviso ? { aviso } : {}),
    });
  } catch (e) {
    return fallo("PATCH", e, "No se pudo actualizar la solicitud", 500);
  }
}
