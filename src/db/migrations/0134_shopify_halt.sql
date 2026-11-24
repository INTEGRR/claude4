-- ===========================================================================
-- 0134  Fulfillment-Halt aus Shopify: angehaltene Bestellungen sperren
-- ===========================================================================
-- Im Shop-Admin wird das Fulfillment einer Bestellung ab und zu angehalten
-- („on hold") — etwas muss noch ins Paket, oder der Kunde möchte warten.
-- KRNL führt den Halt nicht selbst, es spiegelt ihn (Entscheidungslog
-- 2026-11-24): gesetzt und aufgehoben wird NUR in Shopify.
--
--   shopify_halt        Bestellung ist im Shop gerade angehalten
--   shopify_halt_grund  Grund in Betriebsdeutsch („Sonstiges", „Adresse falsch")
--   shopify_halt_notiz  Freitext aus dem Shop („Kabel beilegen")
--   shopify_halt_seit   seit wann KRNL den Halt kennt
--
-- Grund und Notiz bleiben nach dem Aufheben stehen: wer packt, soll den
-- Anlass („Kabel beilegen") auch dann noch sehen.

alter table sales_orders
  add column shopify_halt boolean not null default false,
  add column shopify_halt_grund text,
  add column shopify_halt_notiz text,
  add column shopify_halt_seit timestamptz;

comment on column sales_orders.shopify_halt is
  'Fulfillment im Shop angehalten (on hold) — Versand gesperrt, bis der Shop freigibt — 0134';
comment on column sales_orders.shopify_halt_grund is
  'Grund des (letzten) Halts in Betriebsdeutsch — 0134';
comment on column sales_orders.shopify_halt_notiz is
  'Freitext des (letzten) Halts aus dem Shop; bleibt nach dem Aufheben als Packhinweis — 0134';
comment on column sales_orders.shopify_halt_seit is
  'Seit wann der laufende Halt bekannt ist (null = kein Halt) — 0134';

-- Angehaltene Bestellungen sind nicht versandbereit: sie fehlen damit in
-- der Sammelliste, in der Versandliste, im Massendruck und in den Zählern.
-- Spalten unverändert — nur die Bedingung kommt dazu.
create or replace view shipping_ready as
  select
    p.id            as picking_id,
    p.number        as picking_number,
    p.state         as picking_state,
    so.id           as sales_order_id,
    so.number       as sales_order_number,
    so.shopify_order_name,
    part.name       as customer_name,
    so.ship_zip,
    so.ship_city,
    so.ship_country_code,
    (select count(*) from shipments s where s.picking_id = p.id
       and s.state <> 'cancelled')                       as shipment_count,
    (select coalesce(sum(pt.weight_g * m.qty), 0)::int
       from stock_moves m
       join product_variants pv on pv.id = m.variant_id
       join product_templates pt on pt.id = pv.template_id
      where m.picking_id = p.id and m.state <> 'cancel')  as weight_g,
    p.scheduled_date
  from stock_pickings p
  join operation_types ot on ot.id = p.operation_type_id
  left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
  left join partners part on part.id = p.partner_id
  where ot.kind = 'delivery'
    and p.state = 'assigned'
    and not coalesce(so.shopify_halt, false)
    and not exists (
      select 1 from manufacturing_orders mo
      where mo.sales_order_id = so.id and mo.state not in ('done', 'cancel'));

-- Letzte Sicherung in der Datenbank: eine Lieferung zu einer angehaltenen
-- Bestellung lässt sich auf KEINEM Weg ausbuchen (Packtisch, Label,
-- Massendruck, Transfer von Hand). Die Meldung nennt Grund und Notiz.
create or replace function picking_shopify_halt_pruefen() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if new.state = 'done' and old.state is distinct from new.state
     and new.origin_model = 'sales_order' then
    select so.number, so.shopify_order_name, so.shopify_halt_grund, so.shopify_halt_notiz
      into v
      from sales_orders so
      join operation_types ot on ot.id = new.operation_type_id
     where so.id = new.origin_id and so.shopify_halt and ot.kind = 'delivery';
    if found then
      raise exception '% ist in Shopify angehalten (%) — erst dort freigeben, dann versenden.',
        coalesce(v.shopify_order_name, v.number),
        coalesce(nullif(concat_ws(': ', v.shopify_halt_grund, v.shopify_halt_notiz), ''), 'ohne Angabe');
    end if;
  end if;
  return new;
end $$;

create trigger stock_pickings_shopify_halt
  before update of state on stock_pickings
  for each row execute function picking_shopify_halt_pruefen();
