-- ===========================================================================
-- 0080  Fester search_path für alle Funktionen im Schema public
-- ===========================================================================
-- Befund des Supabase-Sicherheits-Linters (function_search_path_mutable,
-- 166 Funktionen): Eine Funktion ohne festen search_path löst Tabellen und
-- Funktionen zur Laufzeit über den search_path des AUFRUFERS auf. Wer dort
-- ein Schema voranstellen kann, könnte Namen unterschieben. Bei KRNL gibt
-- es nur einen Datenbankbenutzer und keinen anonymen Zugang — ausnutzbar
-- ist das heute nicht, aber „nicht ausnutzbar" ist keine Härtung. Deshalb
-- bekommt jede Routine in public den festen Pfad `public, pg_temp`
-- (pg_catalog wird implizit immer zuerst durchsucht).
-- Sicherheitscheck vor dem Go-Live, Entscheidungslog 2026-09-18.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signatur
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
  loop
    execute format('alter routine %s set search_path = public, pg_temp', r.signatur);
  end loop;
end $$;
