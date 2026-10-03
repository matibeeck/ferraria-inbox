-- Realtime: de postgres_changes a Broadcast por hotel (fase 1 de 2).
--
-- Objetivo: dejar de depender del polling del WAL (postgres_changes), que es el
-- mayor consumidor de CPU de la base en compute Micro. Cada cambio en
-- `conversations` y `Wubby_Whatsapp` se emite por un trigger al topic privado
-- `hotel:<hotel_id>`, y solo lo reciben los usuarios que pueden leer datos de
-- huéspedes de ese hotel.
--
-- Esta migración NO saca las tablas de la publicación `supabase_realtime`: el
-- frontend actual sigue funcionando igual hasta que salga el nuevo. Sacarlas va
-- en una migración posterior, cuando el inbox ya escuche por Broadcast.
--
-- Correr a mano en el SQL Editor. Es aditiva: no cambia ninguna fila existente.
--
-- ---------------------------------------------------------------------------
-- Paso 0 — comprobar ANTES de aplicar (solo lectura):
--
--   -- a) La función que usa la policy existe y qué devuelve (uuid o tabla):
--   SELECT pg_get_function_result('public.user_guest_data_hotel_ids'::regproc);
--
--   -- b) Ambas tablas tienen hotel_id y de qué tipo:
--   SELECT table_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND column_name = 'hotel_id'
--     AND table_name IN ('Wubby_Whatsapp', 'conversations');
--
--   -- c) Qué hay hoy en la publicación (referencia para la fase 2):
--   SELECT schemaname, tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime';
--
--   -- d) No hay policies previas sobre realtime.messages que choquen:
--   SELECT policyname, cmd, roles, qual FROM pg_policies
--   WHERE schemaname = 'realtime' AND tablename = 'messages';
--
--   -- e) Ninguna columna está oculta a `authenticated` por permiso de columna
--   --    (el broadcast manda la fila COMPLETA). Esperado: 0 filas.
--   SELECT table_name, column_name FROM information_schema.columns c
--   WHERE table_schema = 'public' AND table_name IN ('Wubby_Whatsapp', 'conversations')
--     AND NOT has_column_privilege('authenticated',
--           format('public.%I', table_name), column_name, 'SELECT');
-- ---------------------------------------------------------------------------


-- 1) Función del trigger.
--
-- Corre DENTRO de la transacción del INSERT/UPDATE/DELETE del engine. Por eso
-- nunca puede abortar la escritura: si el broadcast falla, se registra un
-- WARNING en los logs de Postgres y el mensaje del huésped se guarda igual.
-- Filas sin hotel_id no se emiten (no hay a qué topic mandarlas).
--
-- En DELETE, NEW es NULL: el hotel sale de OLD. El payload lleva `record`
-- (NEW) y `old_record` (OLD); en DELETE solo viene `old_record`, y como las
-- tablas no tienen REPLICA IDENTITY FULL da igual: el trigger ve la fila
-- completa siempre, a diferencia de postgres_changes.
create or replace function public.broadcast_hotel_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hotel_id text;
begin
  if tg_op = 'DELETE' then
    v_hotel_id := old.hotel_id::text;
  else
    v_hotel_id := new.hotel_id::text;
  end if;

  if v_hotel_id is null then
    return null;
  end if;

  begin
    perform realtime.broadcast_changes(
      'hotel:' || v_hotel_id,  -- topic
      tg_op,                   -- event: INSERT | UPDATE | DELETE
      tg_op,                   -- operation
      tg_table_name,
      tg_table_schema,
      new,
      old
    );
  exception when others then
    raise warning 'broadcast_hotel_changes(%): % [%]', tg_table_name, sqlerrm, sqlstate;
  end;

  return null;  -- AFTER trigger: el valor de retorno se ignora
end;
$$;

-- Función SECURITY DEFINER: nace ejecutable por PUBLIC. Una función que
-- devuelve `trigger` no se puede llamar por RPC, pero se cierra igual por regla.
revoke execute on function public.broadcast_hotel_changes() from public, anon, authenticated;


-- 2) Triggers en las dos tablas.
drop trigger if exists broadcast_hotel_changes on public."Wubby_Whatsapp";
create trigger broadcast_hotel_changes
  after insert or update or delete on public."Wubby_Whatsapp"
  for each row execute function public.broadcast_hotel_changes();

drop trigger if exists broadcast_hotel_changes on public.conversations;
create trigger broadcast_hotel_changes
  after insert or update or delete on public.conversations
  for each row execute function public.broadcast_hotel_changes();


-- 3) Quién puede escuchar el topic `hotel:<id>`.
--
-- Usa `user_guest_data_hotel_ids()`, la MISMA función que ya protege el SELECT
-- de `conversations` y `Wubby_Whatsapp`, y NO una membresía directa en
-- hotel_users: esa función excluye el rol `operativo` (mantenimiento y
-- housekeeping no ven datos de huéspedes) e incluye todos los hoteles para
-- `super_admin`. Una policy sobre hotel_users a secas le mandaría los mensajes
-- de los huéspedes en vivo al personal operativo.
--
-- La comparación es en texto para que un topic mal formado no reviente con un
-- cast a uuid: simplemente no matchea.
--
-- No hay policy de INSERT a propósito: ningún usuario puede publicar en un
-- topic `hotel:*`; solo el trigger (que escribe como owner) emite.
--
-- Diferencia aceptada frente a postgres_changes: la policy se evalúa al unirse
-- al canal y queda en caché hasta que el JWT se renueva. Si a alguien le quitan
-- un hotel o lo pasan a `operativo`, con la pestaña abierta sigue recibiendo
-- ese hotel hasta que venza su token (1 h por defecto). Si un cambio de rol
-- tiene que pegar al instante, hay que acortar la vida del JWT en Auth.
drop policy if exists "hotel topic: leer cambios de datos de huéspedes" on realtime.messages;
create policy "hotel topic: leer cambios de datos de huéspedes"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'hotel:%'
    and split_part((select realtime.topic()), ':', 2) in (
      select g.hotel_id::text
      from public.user_guest_data_hotel_ids() as g(hotel_id)
    )
  );


-- ---------------------------------------------------------------------------
-- Verificación DESPUÉS de aplicar:
--
--   -- a) Los dos triggers están:
--   SELECT event_object_table, trigger_name, string_agg(event_manipulation, ',')
--   FROM information_schema.triggers
--   WHERE trigger_name = 'broadcast_hotel_changes'
--   GROUP BY 1, 2;
--   -- esperado: 2 filas (Wubby_Whatsapp y conversations) con INSERT,UPDATE,DELETE
--
--   -- b) La policy está:
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE schemaname = 'realtime' AND tablename = 'messages';
--
--   -- c) El trigger está emitiendo (esperar a que entre un mensaje en Tigo):
--   SELECT topic, event, inserted_at FROM realtime.messages
--   WHERE topic LIKE 'hotel:%'
--   ORDER BY inserted_at DESC LIMIT 5;
--
-- Rollback (deja todo como estaba; el frontend viejo no se entera):
--
--   DROP TRIGGER IF EXISTS broadcast_hotel_changes ON public."Wubby_Whatsapp";
--   DROP TRIGGER IF EXISTS broadcast_hotel_changes ON public.conversations;
--   DROP FUNCTION IF EXISTS public.broadcast_hotel_changes();
--   DROP POLICY IF EXISTS "hotel topic: leer cambios de datos de huéspedes" ON realtime.messages;
-- ---------------------------------------------------------------------------
