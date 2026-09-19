-- ===========================================================================
-- 0081  Reparatur end-to-end: Zustände, Herkunft, Rückversand — nur Struktur
-- ===========================================================================
-- Der Reparaturprozess bekommt die fehlenden Enden: das Gerät kommt per Post
-- (Retourenlabel → wartet auf Gerät → eingegangen) und geht per Post zurück
-- (Rückversand → versendet). Eine Reparaturanfrage aus dem Kundenformular
-- ist ein Vorgang; der Reparaturauftrag hängt über origin_* daran (Muster
-- 0072). Eine Ausgangssendung gehört zu einer Lieferung ODER zu einer
-- Reparatur — genau eins.
--
-- Diese Datei enthält nur Strukturänderungen. Ein neuer Enum-Wert darf in
-- derselben Transaktion nicht in Zeilen verwendet werden (Muster 0049 →
-- 0050); Funktionen und Seeds folgen in 0082. Entscheidungslog 2026-09-19.

-- --- Reparatur: neue Zustände ---------------------------------------------
alter type repair_state add value if not exists 'awaiting_device' before 'confirmed';
alter type repair_state add value if not exists 'received'        before 'confirmed';
alter type repair_state add value if not exists 'shipped'         after  'repaired';

-- --- Reparatur: Herkunft (Anfrage) und Geräteeingang -------------------------
alter table repair_orders
  add column origin_model text,
  add column origin_id    uuid,
  add column origin_label text,
  add column received_at  timestamptz;

comment on column repair_orders.origin_model is
  'Herkunftsbeleg (z. B. ''vorgang'' = Reparaturanfrage): der Auftrag entstand aus diesem Beleg — Grundlage der Teilprozess-Verkettung (teilprozess_stand).';
comment on column repair_orders.origin_label is
  'Belegnummer der Herkunft im Klartext für Listen/Drucke (Muster sales_orders, 0072).';
comment on column repair_orders.received_at is
  'Wann das Kundengerät im Haus war (Scan am Wareneingang) — keine Bestandsbuchung, das Gerät gehört dem Kunden.';

create index repair_orders_origin_idx on repair_orders (origin_model, origin_id)
  where origin_id is not null;

-- Idempotenz hart in der Datenbank: höchstens EIN Reparaturauftrag je
-- Anfrage — reparatur.anfrage_annehmen verlinkt bei erneutem Klick den
-- bestehenden (Spiegel sales_orders_ein_auftrag_je_vorgang, 0072).
create unique index repair_orders_ein_auftrag_je_vorgang
  on repair_orders (origin_id) where origin_model = 'vorgang';

-- --- Vorgänge: Herkunft eines Eingangs ohne Sitzung -------------------------
alter table vorgaenge
  add column quelle        text not null default 'erp',
  add column absender_hash text;

comment on column vorgaenge.quelle is
  'Woher der Vorgang kam: ''erp'' (angemeldeter Nutzer) oder ''kundenformular'' (öffentliche Seite ohne Sitzung).';
comment on column vorgaenge.absender_hash is
  'Pseudonymer Absender (sha256 mit SESSION_SECRET) eines Eingangs ohne Sitzung — ausschließlich zur Drosselung, nie rückrechenbar (Muster registrierungen.ip_hash).';

create index vorgaenge_absender_idx on vorgaenge (absender_hash, created_at desc)
  where absender_hash is not null;

-- --- Sendungen: Lieferung ODER Reparatur ------------------------------------
-- Expand: picking_id wird optional, der Check erzwingt genau einen Beleg.
alter table shipments alter column picking_id drop not null;
alter table shipments
  add column repair_order_id uuid references repair_orders on delete cascade;
alter table shipments
  add constraint shipments_genau_ein_beleg
  check (num_nonnulls(picking_id, repair_order_id) = 1);
create index shipments_repair_idx on shipments (repair_order_id)
  where repair_order_id is not null;

comment on column shipments.repair_order_id is
  'Rückversand eines reparierten Geräts an den Kunden — Sendung ohne Lieferung/Picking (Bestand ist nicht betroffen, das Gerät gehört dem Kunden).';
