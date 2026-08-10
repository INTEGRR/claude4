-- ===========================================================================
-- Versandregeln: Kleinpaket/Paket-Wahl nach Gewicht, SKU und Zone
-- ===========================================================================
--
-- Vorbild ist Sendclouds Regelwerk („wenn Bedingung, dann Aktion"), reduziert
-- auf das, was am Packtisch wirklich entscheidet:
--
--   Bedingungen: Gewicht (min/max), Zone (DE/EU/Welt), SKU-Muster,
--                „passt ins Kleinpaket" (Produkt-Flag, siehe unten)
--   Aktionen:    DHL-Produkt, Abrechnungsnummer, Versicherung ab Warenwert
--
-- Die Regeln liefern einen VORSCHLAG, den der Packer überschreiben kann —
-- gebucht wird nichts automatisch. Ausgewertet wird in Prioritätsreihenfolge
-- (sequence); je Aktion gewinnt die erste Regel, die sie setzt, weitere
-- Regeln können andere Aktionen beisteuern (Stapeln wie bei Sendcloud).
--
-- Hintergrund Kleinpaket: DHL Kleinpaket (V62KP, seit 01/2025 der
-- Warenpost-Nachfolger) kostet rund die Hälfte eines Pakets, ist aber auf
-- 35,5 × 25 × 8 cm und 1 kg begrenzt. Ob die Ware der Lieferung da
-- hineinpasst, sagt ein Flag am Produkt plus „wie viele Stück füllen ein
-- Kleinpaket" — ehrlicher als rechnerisches 3D-Packen aus Einzelmaßen.

alter table product_templates
  add column kleinpaket boolean not null default false,
  add column kleinpaket_max_qty integer not null default 1
    check (kleinpaket_max_qty > 0);

comment on column product_templates.kleinpaket is
  'Passt (einzeln) in ein DHL Kleinpaket (35,5 x 25 x 8 cm, bis 1 kg).';
comment on column product_templates.kleinpaket_max_qty is
  'Wie viele Stück füllen ein Kleinpaket? Für gemischte Lieferungen zählt '
  'jede Position anteilig: Summe(qty/max_qty) <= 1 heißt „passt".';

create table shipping_rules (
  id          uuid primary key default gen_random_uuid(),
  sequence    integer not null default 10,
  name        text not null,
  active      boolean not null default true,

  -- Bedingungen: null = wird nicht geprüft
  min_weight_g integer,
  max_weight_g integer,
  zone        text check (zone in ('de', 'eu', 'world')),
  skus        text[],                 -- Muster mit *, z. B. {KC-*,KAB-*}
  sku_scope   text not null default 'any' check (sku_scope in ('any', 'all')),
  require_kleinpaket_fit boolean not null default false,

  -- Aktionen: null = Regel setzt diese Aktion nicht
  dhl_product          text,
  billing_number       text,
  insurance_from_value numeric(12,2), -- Transportversicherung ab Warenwert

  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('shipping_rules');
create index shipping_rules_seq_idx on shipping_rules (sequence);

comment on table shipping_rules is
  'Versandregeln (Vorschlag am Packtisch): erste passende Regel je Aktion '
  'gewinnt, Auswertung in sequence-Reihenfolge.';

alter table shipments
  add column insured_value numeric(12,2),
  add column rule_name     text;

comment on column shipments.rule_name is
  'Versandregel, die das DHL-Produkt bestimmt hat (leer bei Handwahl).';

-- Startregeln — bewusst harmlos: die Kleinpaket-Regel greift erst, wenn
-- Produkte das Flag tragen; die Zonenregeln entsprechen der bisherigen
-- Automatik nach Zielland.
insert into shipping_rules
  (sequence, name, zone, require_kleinpaket_fit, max_weight_g, dhl_product) values
  (10, 'Kleinpaket für passendes Zubehör (DE)', 'de', true, 1000, 'V62KP');
insert into shipping_rules (sequence, name, zone, dhl_product) values
  (20, 'Europaket in die EU', 'eu', 'V54EPAK'),
  (30, 'Paket International (Drittland, mit Zolldaten)', 'world', 'V53WPAK');
