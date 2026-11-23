-- Apaga do Umami o que passou do prazo de retenção (:retention, ex.: '6 months').
-- O schema do Umami usa relationMode "prisma": não há chaves estrangeiras, então a ordem
-- só evita deixar filhos órfãos. Uma sessão só sai quando não sobra evento ligado a ela.
\set ON_ERROR_STOP on
BEGIN;
SELECT now() - interval :'retention' AS cutoff \gset
DELETE FROM event_data WHERE created_at < :'cutoff';
DELETE FROM revenue WHERE created_at < :'cutoff';
DELETE FROM website_event WHERE created_at < :'cutoff';
DELETE FROM session_data WHERE created_at < :'cutoff';
DELETE FROM session s
WHERE s.created_at < :'cutoff'
  AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id);
COMMIT;
