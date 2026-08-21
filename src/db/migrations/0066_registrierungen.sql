-- ===========================================================================
-- 0066  Registrierungen von der öffentlichen Startseite
-- ===========================================================================
-- Die Startseite /start hat ein Anmeldeformular („Erzählt uns euren Ablauf"),
-- das OHNE Sitzung schreibt — der einzige unauthentifizierte Schreibweg im
-- System. Deshalb bleibt er bewusst eng: genau diese Tabelle, keine
-- Verknüpfung zu Belegen, keine Rechte, keine Nebenwirkung. Die Weiterarbeit
-- (Status setzen) läuft wieder über den Torwächter.
--
-- Datenschutz: gespeichert wird, was das Formular fragt. Die IP wird NICHT
-- im Klartext abgelegt — nur ein Hash (Zweck: Drosselung gegen Fluten). Der
-- Hash ist mit SESSION_SECRET gesalzen und damit nicht rückrechenbar.
--
-- Rein additiv.

create table registrierungen (
  id               uuid primary key default gen_random_uuid(),
  firma            text not null,
  ansprechpartner  text not null,
  email            text not null,
  telefon          text,
  nutzer           text,          -- Größenklasse als Freitext: '1–10', '11–50', …
  heutiges_system  text,
  ablauf           text not null, -- „Welcher Ablauf klemmt?"
  quelle           text not null default 'startseite',
  status           text not null default 'offen'
                   check (status in ('offen', 'kontaktiert', 'erledigt', 'abgelehnt')),
  notiz            text,
  bearbeitet_am    timestamptz,
  bearbeitet_durch text,
  ip_hash          text,
  created_at       timestamptz not null default now()
);

-- Arbeitsliste: offene zuerst, innerhalb dessen die neuesten.
create index registrierungen_status_idx on registrierungen (status, created_at desc);
-- Drosselung fragt „wie viele aus dieser Quelle in den letzten Minuten?".
create index registrierungen_ip_idx on registrierungen (ip_hash, created_at desc);

comment on table registrierungen is
  'Interessenten von der öffentlichen Startseite (/start). Einziger Schreibweg ohne Sitzung.';
