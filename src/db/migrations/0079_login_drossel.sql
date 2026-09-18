-- ===========================================================================
-- 0079  Login-Drossel: Fehlversuche je Konto und Absender
-- ===========================================================================
-- Die Anmeldung hängt an einer öffentlichen URL. scrypt und die konstante
-- Antwortzeit schützen die Hashes — nicht aber vor geduldigem Durchprobieren
-- am offenen Formular. Deshalb werden Fehlversuche pseudonym festgehalten
-- (Hash aus Konto bzw. Absender-IP mit SESSION_SECRET, kein Klartext); ab
-- 5 je Konto oder 30 je Absender in 15 Minuten ist die Anmeldung gesperrt.
-- Aufräumen übernimmt der Housekeeping-Cron. Entscheidungslog 2026-09-18.

create table login_versuche (
  id            uuid primary key default gen_random_uuid(),
  konto_hash    text not null,
  absender_hash text,
  created_at    timestamptz not null default now()
);

create index login_versuche_konto_idx on login_versuche (konto_hash, created_at);
create index login_versuche_absender_idx on login_versuche (absender_hash, created_at);
