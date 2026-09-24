-- Fase 2 de rendimiento del inbox — índices OPCIONALES de apoyo.
--
-- NADA de esto es necesario para que el código funcione: sin estos índices las
-- consultas devuelven lo mismo, solo que más lento. Correr a mano en el SQL
-- Editor, UNA sentencia por vez (CREATE INDEX CONCURRENTLY no puede ir dentro
-- de una transacción y el editor agrupa varias sentencias en una).
--
-- Paso 0 — ver qué existe ya y cuánto pesa el respaldo por teléfono:
--
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Wubby_Whatsapp';
--   SELECT count(*) FROM "Wubby_Whatsapp" WHERE conversation_id IS NULL;
--   SELECT max(created_at) FROM "Wubby_Whatsapp" WHERE conversation_id IS NULL;


-- 1) Respaldo del hilo para filas SIN conversation_id
--    (lib/inbox-fetch-messages.ts, consulta B de fetchConversationMessagePage):
--      hotel_id = $1 AND conversation_id IS NULL
--      AND (sender IN (…) OR recipient IN (…))
--      ORDER BY created_at DESC, id DESC LIMIT 51
--    Corre en paralelo con la consulta por conversation_id cada vez que se abre
--    un hilo o se cargan anteriores. Sin estos índices Postgres recorre las
--    filas huérfanas del hotel hasta juntar 51 del huésped.
--    Parciales: solo indexan las filas huérfanas, así que no pesan sobre los
--    inserts normales del engine (que llevan conversation_id).
--    Correr SOLO si el conteo del paso 0 no es despreciable.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wubby_orphan_sender_recent
  ON "Wubby_Whatsapp" (hotel_id, sender, created_at DESC, id DESC)
  WHERE conversation_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wubby_orphan_recipient_recent
  ON "Wubby_Whatsapp" (hotel_id, recipient, created_at DESC, id DESC)
  WHERE conversation_id IS NULL;


-- 2) Refresco de acuses tras enviar
--    (app/api/conversations/[id]/message-statuses/route.ts):
--      hotel_id IN (…) AND wamid IN (…hasta 100…)
--    Correr SOLO si el paso 0 no muestra ya un índice que empiece por wamid.
--    Parcial: las filas históricas no tienen wamid.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wubby_wamid
  ON "Wubby_Whatsapp" (wamid)
  WHERE wamid IS NOT NULL;
