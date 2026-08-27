-- ===========================================================================
-- 0078  Druckbrücke mehrstationig: Auftragsarten + Ziele + mehrere Agenten
-- ===========================================================================
-- BUG/00003: neben den Versand-Labels sollen auch Fertigungszettel über die
-- Druckbrücke laufen, und es gibt mehrere PCs mit unterschiedlichen
-- Druckern. Deshalb bekommt jeder Druckauftrag ein ZIEL (logischer
-- Drucker); ein Agent bedient ein oder mehrere Ziele und holt nur diese ab
-- (ein Agent = ein Drucker; für zwei Drucker am selben PC laufen zwei
-- Agenten). Entscheidungslog 2026-08-27.

-- Zettel-Aufträge hängen an einem Fertigungsauftrag statt an einer Sendung.
alter table druckauftraege alter column shipment_id drop not null;
alter table druckauftraege add column mo_id uuid references manufacturing_orders (id) on delete cascade;
-- DESTRUKTIV: nur der Check „art in ('label')" fällt — er wird zwei Zeilen
-- weiter breiter neu angelegt; keine Daten und kein Verhalten gehen verloren.
alter table druckauftraege drop constraint druckauftraege_art_check;
alter table druckauftraege add constraint druckauftraege_art_check
  check (art in ('label', 'zettel'));
alter table druckauftraege add constraint druckauftraege_beleg_check
  check ((art = 'label' and shipment_id is not null)
      or (art = 'zettel' and mo_id is not null));

-- Das logische Ziel entscheidet, welcher Agent den Auftrag zieht.
alter table druckauftraege add column ziel text not null default 'labeldrucker';

comment on column druckauftraege.ziel is
  'Logischer Drucker (labeldrucker, zetteldrucker, …) — Agenten holen nur die Ziele ab, die sie bedienen.';
