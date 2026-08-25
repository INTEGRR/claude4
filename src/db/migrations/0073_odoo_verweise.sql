-- ===========================================================================
-- 0073  Odoo-Verweise: Mapping-Anker für die Datenübernahme aus Odoo 18
-- ===========================================================================
-- ANVIL zieht von Odoo 18 (Odoo.sh) nach KRNL um — alle Daten, wiederholbar
-- (Probeläufe lokal, finaler Lauf am Stichtag mit frischem Dump). Der
-- Importer (scripts/odoo-import.ts) braucht dafür EINEN Anker, der je
-- Odoo-Datensatz festhält, welcher KRNL-Datensatz aus ihm entstanden ist:
--
--  * Idempotenz: jeder Lauf ist ein Upsert über diesen Anker — ein zweiter
--    Lauf mit demselben Dump ist ein No-Op, ein Lauf mit frischerem Dump
--    zieht nur Neues und Geändertes nach.
--  * Delta-Joins: „welche Odoo-Belege fehlen noch" ist ein Anti-Join über
--    diese Tabelle statt einer Raterei über Belegnummern.
--  * Herkunft: nach der Migration ist an einem Ort nachvollziehbar, woher
--    jeder übernommene Datensatz stammt (und die Tabelle ist als Ganzes
--    löschbar, wenn die Herkunft niemanden mehr interessiert).
--
-- Bewusst KEINE zusatz->>'odoo_id'-Ablage: den zusatz-Sack gibt es nur an
-- vier Tabellen (partners, product_templates, sales_orders, repair_orders),
-- der Anker wird aber auch für Varianten, Auftragszeilen, Einheiten,
-- Steuern, Stücklisten und Fertigungsaufträge gebraucht — und nur eine
-- echte Tabelle liefert den Unique-Constraint, der Upsert-Idempotenz
-- garantiert. Vorbild sind die dedizierten Shopify-Spalten (0002/0005);
-- eine je Odoo-Tabelle wäre Spalten-Wildwuchs, deshalb eine Mapping-Tabelle.
--
-- Der Primärschlüssel ist der natürliche Odoo-Schlüssel (tabelle, id) und
-- kein uuid — die Tabelle IST die Übersetzung zwischen den Schlüsselwelten,
-- ein dritter Kunstschlüssel hätte keinen Nutzen (Entscheidungslog
-- 2026-08-25). Kein Fremdschlüssel auf krnl_id: die Zielzeile lebt in je
-- nach Eintrag anderen Tabellen, und die Werkszustand-Mechanik (0069)
-- räumt diese Tabelle ohnehin mit ab (sie steht bewusst NICHT in der
-- Behalten-Liste — ein leergeräumtes System hat keine Übernahme-Herkunft).

create table odoo_verweise (
  odoo_tabelle text        not null,  -- 'res_partner', 'sale_order', …
  odoo_id      bigint      not null,  -- Odoo-Primärschlüssel
  krnl_tabelle text        not null,  -- 'partners', 'sales_orders', …
  krnl_id      uuid        not null,  -- Ziel-Datensatz in KRNL
  lauf         text        not null,  -- Label des Importlaufs ('probe-1', Stichtag)
  created_at   timestamptz not null default now(),
  primary key (odoo_tabelle, odoo_id)
);

comment on table odoo_verweise is
  'Datenübernahme aus Odoo 18: welcher KRNL-Datensatz entstand aus welchem '
  'Odoo-Datensatz. Anker für idempotente Importläufe (scripts/odoo-import.ts); '
  'nach Abschluss der Migration reine Herkunfts-Doku.';

-- Rückrichtung: „woher stammt dieser KRNL-Datensatz?" (Verifikationsreport,
-- Fehlersuche nach einem Probelauf).
create index odoo_verweise_krnl_idx on odoo_verweise (krnl_tabelle, krnl_id);
