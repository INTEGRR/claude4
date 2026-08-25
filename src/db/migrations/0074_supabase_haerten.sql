-- Supabase-Härtung: die automatisch bereitgestellte Data-API (PostgREST)
-- darf die ERP-Tabellen nicht sehen.
--
-- Befund (Security-Advisor des Prod-Projekts, 2026-08-25): 101 Tabellen
-- „rls_disabled_in_public" — Supabase legt Default-Grants für die
-- API-Rollen anon/authenticated auf das public-Schema, und KRNL nutzt
-- bewusst kein RLS (klassische Server-Anwendung, die Anwendung selbst
-- ist die einzige Zugriffsschicht). Ohne diesen Entzug könnte der
-- öffentliche anon-Key der Data-API Tabellen lesen und schreiben.
--
-- Zweifache Schließung: die Data-API wird im Dashboard deaktiviert UND
-- hier werden die Rechte entzogen — versioniert, damit jeder künftige
-- Neuaufbau (auch der Stichtags-Lauf) automatisch dicht ist.
-- Entscheidungslog 2026-08-25. Auf Instanzen ohne Supabase-Rollen
-- (lokal, Docker) ist die Migration ein No-Op.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated';
    execute 'revoke usage on schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
  end if;
end $$;
