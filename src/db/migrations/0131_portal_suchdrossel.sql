-- ===========================================================================
-- 0131  Retourenportal: Fehlversuche der Bestellsuche drosseln
-- ===========================================================================
-- Das Portal (0119) verlangt Bestellnummer + E-Mail und antwortet auf jede
-- falsche Kombination gleich. Gedrosselt war aber nur das Absenden, nicht
-- die Suche davor: wer eine E-Mail-Adresse kennt, konnte Bestellnummern
-- automatisiert durchprobieren und so die Bestellungen einer Person samt
-- Artikeln einsammeln. Jetzt zählt jeder Fehlversuch pseudonym je E-Mail,
-- je Bestellnummer und je Shop-Kunde (Hash mit SESSION_SECRET, kein
-- Klartext, Muster der Login-Drossel 0079); ab 10 in einer Stunde ist die
-- Suche für diese Kennung gesperrt. Aufräumen passiert beim Zählen.
-- Entscheidungslog 2026-10-18.

create table portal_suchversuche (
  id           uuid primary key default gen_random_uuid(),
  kennung_hash text not null,
  created_at   timestamptz not null default now()
);

create index portal_suchversuche_kennung_idx on portal_suchversuche (kennung_hash, created_at);
