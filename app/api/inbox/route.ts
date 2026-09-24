/** Bandeja: GET fusiona `conversations` + mensajes `Wubby_Whatsapp`; PATCH actualiza solo `conversations`. */
import { NextResponse } from "next/server";
import { buildInboxConversations, getConversationDisplayActivityMs } from "@/lib/chat-utils";
import {
  buildHotelWhatsappByIdMap,
  hotelWhatsappMapToRecord,
} from "@/lib/hotel-whatsapp-map";
import { buildReactivateAiFields } from "@/lib/inbox-patch";
import {
  availableHotelsFrom,
  resolveActiveHotelId,
  type AvailableHotel,
} from "@/lib/inbox-tenant";
import {
  CONVERSATIONS_TABLE,
  CONVERSATION_SELECT_COLUMNS,
  GUEST_NAME_MAX_LENGTH,
  type ConversationDbRow,
  type InboxPatchAction,
} from "@/lib/conversation-schema";
import { requireSessionUser } from "@/lib/auth/require-user";
import { requireCapability } from "@/lib/auth/require-capability";
import { assertConversationInHotel } from "@/lib/auth/require-hotel";
import { STAFF_CONTACTS_TABLE, normalizeStaffPhone } from "@/lib/staff-contacts";
import { fetchTicketBadges, markTicketBadges } from "@/lib/inbox-ticket-badges-server";
import type { Conversation } from "@/lib/inbox-types";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { MESSAGES_LIMIT } from "@/lib/message-limits";
import {
  buildDescKeysetOrFilter,
  encodeKeysetCursor,
  parseKeysetCursor,
} from "@/lib/inbox-keyset";
import { WUBBY_PREVIEW_COLUMNS, WUBBY_TABLE, type WubbyWhatsappRow } from "@/lib/wubby-schema";

export const dynamic = "force-dynamic";

/**
 * Embedding PostgREST: cada fila de `conversations` con su ÚLTIMO mensaje.
 * Junto al `.order(...)` + `.limit(1, { referencedTable })` de abajo equivale a
 * un `distinct on (conversation_id)`, que el cliente supabase-js no sabe emitir.
 * Se apoya en el FK `wubby_conversation_id_fkey` y en el índice
 * `idx_wubby_conv_recent (conversation_id, created_at DESC, id DESC)`.
 */
const CONVERSATIONS_WITH_LAST_MESSAGE_SELECT = `${CONVERSATION_SELECT_COLUMNS}, sort_activity_at, ${WUBBY_TABLE}(${WUBBY_PREVIEW_COLUMNS})`;

/** Fila de `conversations` con el array embebido (0 o 1 elementos). */
type ConversationRowWithLastMessage = ConversationDbRow & {
  Wubby_Whatsapp?: WubbyWhatsappRow[] | null;
};

/**
 * Tamaño de página de la bandeja. La lista pinta ~12 filas por pantalla: 30
 * llenan la primera vista con margen y el resto llega con scroll infinito por
 * cursor keyset (`?before=<sort_activity_at>|<id>`).
 *
 * Antes eran 300 fijas sin forma de pedir más: ahora todo el hotel es
 * alcanzable bajando, y la carga inicial pesa un décimo.
 */
const CONVERSATIONS_PAGE_SIZE = 30;

/**
 * Set protegido: conversaciones que tienen que estar en memoria aunque no
 * caigan en la primera página, porque de ellas cuelgan el chip "Atención", el
 * "Sin leer" y los distintivos de la fila. Solo se piden en la PRIMERA página;
 * las siguientes son puro keyset.
 *
 * A propósito MÁS AMPLIO que el chip "Atención" — acá no se clasifica, se
 * garantiza un superconjunto.
 *
 * `request` —no `status`— es la columna donde vive `pending`: el dominio de
 * `status` es open / completed / human_control. `human_control` va aparte porque
 * `mapOperationalFromConversationRow` lo clasifica como `requires_attention`.
 */
const PROTECTED_CONVERSATIONS_FILTER = [
  "request.eq.pending",
  "status.eq.human_control",
  "blocked.eq.true",
  "needs_human.eq.true",
  "unread_count.gt.0",
].join(",");

/**
 * Tope del set protegido. Hoy son ~37 filas en el hotel más grande y 97 en el
 * de más carga operativa: 50, ordenadas por actividad, cubren todas las que
 * están vivas y dejan afuera la cola larga de pendientes viejos (bloqueados de
 * hace meses, `needs_human` que nadie cerró). Esas siguen apareciendo al bajar
 * con el scroll, igual que cualquier otra.
 *
 * Mismas columnas que una fila de página (`CONVERSATIONS_WITH_LAST_MESSAGE_SELECT`)
 * y no un recorte: una protegida SE PINTA como fila (nombre, preview, hora,
 * semáforo, badges) y es la misma conversación que después puede llegar por
 * keyset. Si viajara con menos columnas, la fila saldría incompleta en
 * "Atención" y cambiaría de forma al llegar por la otra vía.
 */
const PROTECTED_CONVERSATIONS_LIMIT = 50;

/**
 * RPC de búsqueda por nombre y teléfono. `SECURITY INVOKER` y `STABLE`: pliega
 * acentos, normaliza los dígitos del teléfono, exige 2+ caracteres (3+ dígitos
 * para el match numérico) y ordena por `sort_activity_at desc, id desc`.
 *
 * Devuelve `SETOF conversations`, o sea filas crudas SIN el embed del último
 * mensaje — de ahí la segunda consulta de abajo.
 *
 * Corre con el cliente de service role, que omite RLS: el gate de tenant es
 * `resolveActiveHotelId`, que ya validó que `activeHotelId` sea del usuario
 * antes de llegar acá. El RPC nunca recibe un hotel sin autorizar.
 */
const SEARCH_CONVERSATIONS_RPC = "search_conversations";

/** Tope de resultados de búsqueda. El RPC además lo capa a 200. */
const SEARCH_PAGE_SIZE = 50;

/**
 * Mínimo de caracteres, el mismo que exige el RPC. Se comprueba acá para no
 * gastar un round trip en un término que la función va a descartar igual.
 */
const SEARCH_MIN_LENGTH = 2;

/**
 * Consulta base de bandeja para un hotel: columnas de `conversations` + embed
 * del último mensaje. La comparten la consulta por actividad, la del set
 * protegido y la de búsqueda, así que el embed y su `limit(1)` no pueden
 * divergir entre ellas.
 */
function buildInboxConversationsQuery(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  hotelId: string
) {
  return supabase
    .from(CONVERSATIONS_TABLE)
    .select(CONVERSATIONS_WITH_LAST_MESSAGE_SELECT)
    .eq("hotel_id", hotelId)
    .order("created_at", { referencedTable: WUBBY_TABLE, ascending: false })
    .order("id", { referencedTable: WUBBY_TABLE, ascending: false })
    .limit(1, { referencedTable: WUBBY_TABLE });
}

/** Separa las filas con embed en `conversations` puras + mapa de último mensaje. */
function splitEmbeddedRows(rawRows: ConversationRowWithLastMessage[]) {
  const convRows: ConversationDbRow[] = [];
  const lastMessageByConversationId = new Map<string, WubbyWhatsappRow>();

  for (const raw of rawRows) {
    const { Wubby_Whatsapp: embedded, ...conv } = raw;
    convRows.push(conv as ConversationDbRow);
    const lastRow = Array.isArray(embedded) ? embedded[0] : null;
    if (lastRow) {
      lastMessageByConversationId.set(String(conv.id), lastRow);
    }
  }

  return { convRows, lastMessageByConversationId };
}

/**
 * Teléfonos del personal del hotel, normalizados, en un solo SELECT.
 *
 * UNA consulta por GET de bandeja, no una por conversación: son unas decenas de
 * filas por hotel y entran de sobra en una página de PostgREST.
 *
 * NUNCA tira el GET: si la consulta falla, la bandeja se sirve igual y las filas
 * salen sin marca. El badge es informativo; que una recepcionista no pueda ver
 * su bandeja porque `staff_contacts` falló sería un cambio pésimo.
 */
async function fetchActiveStaffPhones(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  hotelId: string
): Promise<Set<string>> {
  const phones = new Set<string>();

  const { data, error } = await supabase
    .from(STAFF_CONTACTS_TABLE)
    .select("phone")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);

  if (error) {
    // Sin PII: solo el hotel y el code. La bandeja sigue.
    console.error("[inbox GET] staff_contacts", error.code ?? "sin_code", { hotelId });
    return phones;
  }

  for (const row of data ?? []) {
    const normalized = normalizeStaffPhone(String((row as { phone?: unknown }).phone ?? ""));
    if (normalized) phones.add(normalized);
  }

  return phones;
}

/**
 * Marca `isStaff` comparando teléfonos NORMALIZADOS por las dos puntas con la
 * misma utilidad (`normalizeStaffPhone`). `guest_phone` llega con y sin `+` y
 * `staff_contacts.phone` se guarda solo en dígitos: comparar crudo fallaría de
 * forma silenciosa justo en la mitad de los hoteles.
 *
 * Muta en sitio: el array recién lo construyó este handler.
 */
function markStaffConversations(conversations: Conversation[], staffPhones: Set<string>): void {
  if (staffPhones.size === 0) return;
  for (const conversation of conversations) {
    const normalized = normalizeStaffPhone(conversation.guestPhone ?? "");
    if (normalized && staffPhones.has(normalized)) {
      conversation.isStaff = true;
    }
  }
}

function emptyInboxResponse(availableHotels: AvailableHotel[] = [], activeHotelId: string | null = null) {
  return NextResponse.json({
    conversations: [],
    fetchedConversations: 0,
    // La bandeja ya no embarca historial: el hilo se pide aparte a
    // GET /api/inbox/messages. Se mantiene el campo para no romper el contrato.
    fetchedMessages: 0,
    messageLimit: MESSAGES_LIMIT,
    availableHotels,
    activeHotelId,
    hotelWhatsappById: {},
    // Sin hotel activo resuelto no hay flag que leer. `false` = la UI de staff
    // no se pinta, que es el default seguro en todos los caminos.
    engineEnabled: false,
    // Mismo criterio: sin hotel resuelto no se ofrece enviar plantillas. El
    // servidor las bloquea igual, así que acá el default seguro es no pintarlas.
    templatesEnabled: false,
    conversationsPageSize: CONVERSATIONS_PAGE_SIZE,
    hasMore: false,
    nextCursor: null,
    query: null,
  });
}

/** Error de Supabase para el cliente: el detalle crudo solo fuera de producción. */
function upstreamError(label: string, error: { code?: string; message?: string }) {
  console.error(`[inbox GET] ${label}`, error.code ?? "sin_code");
  const isDev = process.env.NODE_ENV !== "production";
  return NextResponse.json(
    { error: isDev && error.message ? error.message : "No se pudo cargar la bandeja" },
    { status: 502 }
  );
}

export async function GET(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const supabase = getSupabaseServerClient();
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    // Filas de `hotels` ya leídas por el gate (en paralelo con `hotel_users`),
    // recortadas a los hoteles que ESTE endpoint puede ver. Reemplazan las dos
    // lecturas de `hotels` que había acá: selector y número de WhatsApp + flags.
    const allowedSet = new Set(allowedHotelIds);
    const hotelRows = gate.tenant.hotels.filter((hotel) => allowedSet.has(hotel.id));
    const searchParams = new URL(request.url).searchParams;
    const requestedHotelId = searchParams.get("hotelId")?.trim() ?? "";
    const searchTerm = searchParams.get("q")?.trim() ?? "";
    const availableHotels = availableHotelsFrom(hotelRows, allowedHotelIds);
    const { activeHotelId, forbidden } = resolveActiveHotelId(
      requestedHotelId,
      allowedHotelIds,
      availableHotels
    );

    // Sin PII: `userId` / `email` se emitían en CADA GET, incluidos los refetch
    // silenciosos. Y solo fuera de producción, con conteos en vez de los arrays
    // completos de hoteles.
    if (process.env.NODE_ENV !== "production") {
      console.log("[inbox GET] tenant access", {
        allowedHotelCount: allowedHotelIds.length,
        availableHotelCount: availableHotels.length,
        activeHotelId,
        requestedHotelId: requestedHotelId || null,
      });
    }

    if (forbidden) {
      return NextResponse.json({ error: "No autorizado para ver este hotel" }, { status: 403 });
    }

    if (allowedHotelIds.length === 0 || !activeHotelId) {
      return emptyInboxResponse(availableHotels, activeHotelId);
    }

    const hotelWhatsappById = buildHotelWhatsappByIdMap(
      hotelRows.map((hotel) => ({ id: hotel.id, whatsapp_number: hotel.whatsappNumber }))
    );

    /**
     * Flag de engine del hotel ACTIVO. Sale de la MISMA fila que el
     * `whatsapp_number` (directorio de `hotels` del gate): CERO consultas
     * nuevas — esta route salió de una cirugía de OOM y no admite trabajo extra
     * por GET, y menos por conversación.
     *
     * Se manda un booleano del hotel activo, no un mapa por hotel: el único
     * consumidor es el gate de UI de staff, que solo mira el hotel abierto, y
     * `activeHotelId` ya viaja en la misma respuesta.
     *
     * Default `false` si la fila falta o la columna viene null. Es el lado
     * seguro: en un hotel que todavía corre en n8n la IA le responde igual al
     * personal (el guard de staff vive en el engine), así que registrar
     * contactos ahí haría que la feature pareciera rota.
     */
    const engineEnabled = hotelRows.some(
      (hotel) => hotel.id === activeHotelId && hotel.engineEnabled
    );

    /**
     * `hotels.templates_enabled` del hotel ACTIVO. Mismo molde que el flag de
     * arriba: sale del directorio de `hotels` del gate, cero consultas nuevas
     * y un booleano del hotel abierto, no un mapa por hotel.
     *
     * Apaga el envío manual de plantillas en la UI. Hay hoteles donde las
     * plantillas no se pueden facturar en Meta, así que recepción no debe poder
     * mandarlas hasta que eso se resuelva.
     *
     * Default `false` si la fila falta o la columna viene null: preferimos
     * esconder el botón de más antes que ofrecer un envío que el servidor va a
     * rechazar con 403. El gate real vive en `POST /api/send-whatsapp-template`;
     * esto es solo UI.
     */
    const templatesEnabled = hotelRows.some(
      (hotel) => hotel.id === activeHotelId && hotel.templatesEnabled
    );

    // Camino de búsqueda. Aditivo: sin `q` nada de esto corre y el resto del
    // handler queda exactamente como estaba.
    //
    // A propósito NO aplica `CONVERSATIONS_PAGE_SIZE` ni el set protegido: los
    // dos son heurísticas para decidir QUÉ mostrar cuando no hay criterio, y con
    // un criterio explícito sabotearían la búsqueda — el match podría estar
    // en una página que todavía no se cargó y fuera del set protegido. Tampoco
    // pagina: devuelve el tope del RPC de una vez.
    if (searchTerm) {
      if (searchTerm.length < SEARCH_MIN_LENGTH) {
        return NextResponse.json({
          conversations: [],
          fetchedConversations: 0,
          fetchedMessages: 0,
          messageLimit: MESSAGES_LIMIT,
          availableHotels,
          activeHotelId,
          hotelWhatsappById: hotelWhatsappMapToRecord(hotelWhatsappById),
          engineEnabled,
          templatesEnabled,
          conversationsPageSize: CONVERSATIONS_PAGE_SIZE,
          hasMore: false,
          nextCursor: null,
          query: searchTerm,
          searchLimit: SEARCH_PAGE_SIZE,
        });
      }

      const [rpcResult, staffPhones, ticketBadges] = await Promise.all([
        supabase.rpc(SEARCH_CONVERSATIONS_RPC, {
          p_hotel_id: activeHotelId,
          p_q: searchTerm,
          p_limit: SEARCH_PAGE_SIZE,
        }),
        // El badge de staff también en resultados de búsqueda: si no, la misma
        // conversación se vería marcada en la bandeja y sin marcar al buscarla.
        fetchActiveStaffPhones(supabase, activeHotelId),
        // Mismo argumento para el badge de solicitud: buscar a un huésped no
        // puede esconder que tiene algo pendiente sin atender.
        fetchTicketBadges(supabase, activeHotelId),
      ]);

      if (rpcResult.error) {
        return upstreamError("search_conversations", rpcResult.error);
      }

      const matchedIds = ((rpcResult.data ?? []) as ConversationDbRow[]).map((row) =>
        String(row.id)
      );

      // El RPC devuelve `SETOF conversations`, sin el embed del último mensaje.
      // Segunda consulta por los ids, reusando la MISMA query base que la
      // bandeja: así el preview de un resultado se construye por el mismo camino
      // que el de una fila normal y no pueden divergir.
      //
      // La alternativa —devolver los resultados sin preview— dejaba "Sin
      // mensajes" en cada fila y, peor, mandaba `lastActivityIso` al `created_at`
      // de la conversación (ver `buildInboxConversations`), cambiando el orden y
      // la fecha visible respecto de la misma conversación en la bandeja.
      let searchRows: ConversationRowWithLastMessage[] = [];
      if (matchedIds.length > 0) {
        const withPreview = await buildInboxConversationsQuery(supabase, activeHotelId).in(
          "id",
          matchedIds
        );

        if (withPreview.error) {
          return upstreamError("preview de resultados", withPreview.error);
        }

        searchRows = (withPreview.data ?? []) as unknown as ConversationRowWithLastMessage[];
      }

      const { convRows, lastMessageByConversationId } = splitEmbeddedRows(searchRows);
      const conversations = buildInboxConversations(convRows, lastMessageByConversationId);
      markStaffConversations(conversations, staffPhones);
      markTicketBadges(conversations, ticketBadges);
      conversations.sort((a, b) => {
        return getConversationDisplayActivityMs(b) - getConversationDisplayActivityMs(a);
      });

      return NextResponse.json({
        conversations,
        fetchedConversations: convRows.length,
        fetchedMessages: 0,
        messageLimit: MESSAGES_LIMIT,
        availableHotels,
        activeHotelId,
        hotelWhatsappById: hotelWhatsappMapToRecord(hotelWhatsappById),
        engineEnabled,
        templatesEnabled,
        conversationsPageSize: CONVERSATIONS_PAGE_SIZE,
        // La búsqueda no pagina: el RPC ya devuelve su tope completo.
        hasMore: false,
        nextCursor: null,
        // Eco del término aplicado: el cliente descarta con esto las respuestas
        // que llegan fuera de orden respecto de lo que hay tipeado.
        query: searchTerm,
        searchLimit: SEARCH_PAGE_SIZE,
      });
    }

    // Cursor keyset de "cargar más". Sin `before` es la primera página, la
    // única que además trae el set protegido. Un cursor que no valida no se
    // interpola en el filtro: 400.
    const beforeRaw = searchParams.get("before")?.trim() ?? "";
    const cursor = beforeRaw ? parseKeysetCursor(beforeRaw) : null;
    if (beforeRaw && !cursor) {
      return NextResponse.json({ error: "Cursor de página inválido" }, { status: 400 });
    }
    const isFirstPage = cursor === null;

    // A) Página por actividad. `sort_activity_at` es la columna generada
    // `coalesce(last_guest_message_at, created_at)`; el orden por `id` desempata
    // para que el corte sea determinista. Ambos los cubre
    // `idx_conversations_hotel_activity (hotel_id, sort_activity_at desc, id desc)`.
    // `desc` sin `nullsFirst` explícito = NULLS FIRST, el mismo orden de antes y
    // el que asume el predicado keyset. Se pide UNA fila de más solo para saber
    // si hay otra página, sin contar la tabla.
    let pageQuery = buildInboxConversationsQuery(supabase, activeHotelId);
    if (cursor) {
      pageQuery = pageQuery.or(buildDescKeysetOrFilter("sort_activity_at", "id", cursor));
    }
    const pageRequest = pageQuery
      .order("sort_activity_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(CONVERSATIONS_PAGE_SIZE + 1);

    // B) Set protegido, solo en la primera página. Mismo orden que A para que,
    // si pasa el tope, lo que quede afuera sea lo más viejo.
    const protectedRequest = isFirstPage
      ? buildInboxConversationsQuery(supabase, activeHotelId)
          .or(PROTECTED_CONVERSATIONS_FILTER)
          .order("sort_activity_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(PROTECTED_CONVERSATIONS_LIMIT)
      : null;

    // Independientes entre sí: el GET cuesta un round trip, no cuatro. Sin
    // `count: exact`: contar la tabla en cada carga era la consulta más cara del
    // GET y solo alimentaba un denominador.
    const [pageResult, protectedResult, staffPhones, ticketBadges] = await Promise.all([
      pageRequest,
      protectedRequest,
      // Contactos de staff del hotel activo, para el badge de la bandeja.
      fetchActiveStaffPhones(supabase, activeHotelId),
      // Solicitudes de servicio sin resolver, para el badge de la fila. UNA
      // consulta por GET, no una por conversación.
      fetchTicketBadges(supabase, activeHotelId),
    ]);

    if (pageResult.error) {
      return upstreamError("conversations", pageResult.error);
    }
    if (protectedResult?.error) {
      return upstreamError("conversations protegidas", protectedResult.error);
    }

    const fetchedPageRows = (pageResult.data ?? []) as unknown as ConversationRowWithLastMessage[];
    const hasMore = fetchedPageRows.length > CONVERSATIONS_PAGE_SIZE;
    const pageRows = hasMore ? fetchedPageRows.slice(0, CONVERSATIONS_PAGE_SIZE) : fetchedPageRows;
    const protectedRows = (protectedResult?.data ??
      []) as unknown as ConversationRowWithLastMessage[];

    // El cursor sale de la ÚLTIMA fila de la página keyset, nunca de una
    // protegida: esas no siguen el orden de la página.
    const lastPageRow = pageRows.at(-1);
    const nextCursor =
      hasMore && lastPageRow
        ? encodeKeysetCursor(lastPageRow.sort_activity_at ?? null, lastPageRow.id)
        : null;

    // Unión por id. El set protegido se solapa casi por completo con la
    // primera página, así que la dedup no es una optimización: sin ella la
    // misma conversación entraría dos veces y `buildInboxConversations` la
    // duplicaría en la bandeja.
    const rowById = new Map<string, ConversationRowWithLastMessage>();
    for (const row of pageRows) rowById.set(String(row.id), row);
    for (const row of protectedRows) {
      const id = String(row.id);
      if (!rowById.has(id)) rowById.set(id, row);
    }
    const rawRows = [...rowById.values()];

    // Única señal de que el set protegido quedó recortado: el tope no produce
    // error. Sin gate de NODE_ENV a propósito — solo en producción un hotel
    // puede llegar ahí —, y sin PII: `hotel_id` y conteos.
    if (protectedRows.length >= PROTECTED_CONVERSATIONS_LIMIT) {
      console.warn("[inbox GET] set protegido en el tope", {
        hotelId: activeHotelId,
        fetchedProtected: protectedRows.length,
        limit: PROTECTED_CONVERSATIONS_LIMIT,
      });
    }

    const { convRows, lastMessageByConversationId } = splitEmbeddedRows(rawRows);

    // `buildInboxConversations` corta el preview a 120 caracteres
    // (`truncateListPreview`): es lo único del cuerpo del mensaje que sale en
    // la respuesta.
    const conversations = buildInboxConversations(convRows, lastMessageByConversationId);
    markStaffConversations(conversations, staffPhones);
    markTicketBadges(conversations, ticketBadges);
    conversations.sort((a, b) => {
      return getConversationDisplayActivityMs(b) - getConversationDisplayActivityMs(a);
    });

    return NextResponse.json({
      conversations,
      fetchedConversations: convRows.length,
      // Cero por diseño: la bandeja ya no embarca historial.
      fetchedMessages: 0,
      messageLimit: MESSAGES_LIMIT,
      availableHotels,
      activeHotelId,
      hotelWhatsappById: hotelWhatsappMapToRecord(hotelWhatsappById),
      engineEnabled,
      templatesEnabled,
      conversationsPageSize: CONVERSATIONS_PAGE_SIZE,
      // `hasMore` + `nextCursor` reemplazan a `total`: el cliente pide la
      // siguiente página con `?before=<nextCursor>` al llegar al final.
      hasMore,
      nextCursor,
      // `null` = esta respuesta NO es de búsqueda. El campo está siempre para
      // que el cliente pueda leerlo sin ramificar por su ausencia.
      query: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[inbox GET]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSessionUser();
    if (auth.response) return auth.response;

    const body = (await request.json()) as {
      conversationId?: string;
      action?: InboxPatchAction;
      guestName?: string;
    };

    const conversationId = body.conversationId?.trim();
    if (!conversationId) {
      return NextResponse.json({ error: "conversationId es obligatorio" }, { status: 400 });
    }

    const action = body.action;
    if (
      action !== "human_control" &&
      action !== "reactivate_ai" &&
      action !== "completed" &&
      action !== "resolve_request" &&
      action !== "reopen" &&
      action !== "mark_read" &&
      action !== "rename"
    ) {
      return NextResponse.json(
        {
          error:
            "action debe ser human_control, reactivate_ai, completed, resolve_request, reopen, mark_read o rename",
        },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    let patch: Record<string, unknown> = { updated_at: now };

    switch (action) {
      case "human_control":
        patch = {
          ...patch,
          needs_human: true,
          ai_active: false,
          status: "human_control",
          // Reloj de la reactivación automática del engine: marca desde cuándo
          // esta conversación está en manos de una persona. Es CORREDIZO —cada
          // acción humana posterior (responder, mandar plantilla) lo vuelve a
          // estampar—, así que las ~2 h se cuentan desde la última intervención
          // y el barrido no le quita la conversación a quien la está atendiendo.
          human_control_at: now,
        };
        break;
      case "reactivate_ai":
        patch = {
          ...patch,
          ...buildReactivateAiFields(now),
          status: "open",
        };
        break;
      case "completed":
        patch = {
          ...patch,
          ...buildReactivateAiFields(now),
          request: null,
          status: "completed",
        };
        break;
      case "resolve_request":
        patch = {
          ...patch,
          request: null,
        };
        break;
      case "reopen":
        // Inversa de `completed`: reabrir pone `status = 'open'` y respeta
        // `ai_active` / `needs_human` dejados al cerrar (p. ej. IA reactivada).
        patch = {
          ...patch,
          status: "open",
        };
        break;
      case "mark_read":
        patch = {
          ...patch,
          unread_count: 0,
          last_read_at: now,
        };
        break;
      case "rename": {
        const guestName = typeof body.guestName === "string" ? body.guestName.trim() : "";
        if (!guestName) {
          return NextResponse.json(
            { error: "El nombre del huésped no puede estar vacío" },
            { status: 400 }
          );
        }
        if (guestName.length > GUEST_NAME_MAX_LENGTH) {
          return NextResponse.json(
            { error: `El nombre no puede superar ${GUEST_NAME_MAX_LENGTH} caracteres` },
            { status: 400 }
          );
        }
        patch = {
          ...patch,
          guest_name: guestName,
        };
        break;
      }
      default:
        return NextResponse.json({ error: "Acción no válida" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // Ownership obligatorio para TODAS las acciones: deriva el hotel de la
    // conversación y valida que pertenezca a un hotel permitido del usuario.
    const gate = await requireCapability(supabase, auth.user, "verConversacionesHuespedes");
    if (gate.response) return gate.response;
    const allowedHotelIds = gate.allowedHotelIds;
    const ownership = await assertConversationInHotel(supabase, conversationId, allowedHotelIds);
    if (ownership.response) return ownership.response;

    // `returning=representation` con las columnas de bandeja: la fila resultante
    // es POST-update, así que trae también los campos derivados que el `patch` no
    // toca pero que el cliente necesita para recalcular el estado visible (p. ej.
    // `blocked`, que ninguna acción escribe y sin embargo tiene precedencia en
    // `mapOperationalFromConversationRow`). Sigue funcionando como candado de
    // existencia: sin fila, 404.
    const { data: updatedRow, error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .update(patch)
      .eq("id", conversationId)
      .eq("hotel_id", ownership.hotelId)
      .select(CONVERSATION_SELECT_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error("[inbox PATCH]", error);
      return NextResponse.json(
        { error: error.message || "No se pudo actualizar la conversación" },
        { status: 502 }
      );
    }
    if (!updatedRow) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    // `conversation` permite al cliente aplicar `applyConversationRowPatch` —el
    // mismo handler que consume Realtime— en vez de recargar la bandeja entera.
    return NextResponse.json({
      ok: true,
      conversationId,
      action,
      conversation: updatedRow,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
