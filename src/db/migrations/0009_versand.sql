-- ===========================================================================
-- Versand: DHL-Sendungen und Retourenlabels
-- ===========================================================================

create type shipment_state as enum
  ('created', 'manifested', 'transit', 'delivered', 'failure', 'cancelled');

create table shipments (
  id                     uuid primary key default gen_random_uuid(),
  picking_id             uuid not null references stock_pickings on delete cascade,
  sales_order_id         uuid references sales_orders on delete set null,
  carrier                text not null default 'dhl',
  dhl_product            text not null default 'V01PAK',
  billing_number         text not null,
  weight_g               int not null check (weight_g > 0),
  shipment_number        text unique,          -- = Trackingnummer
  tracking_url           text,
  state                  shipment_state not null default 'created',
  label_path             text,                 -- DHL hält Labels nur ~3 Tage vor
  label_format           text not null default '910-300-700',
  dhl_warnings           jsonb,
  last_tracking_event    jsonb,
  last_tracking_check    timestamptz,
  shopify_fulfillment_id text,
  manifested_at          timestamptz,
  delivered_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz
);
select attach_touch_trigger('shipments');
create index shipments_picking_idx on shipments (picking_id);
create index shipments_tracking_idx on shipments (state, last_tracking_check)
  where state in ('created', 'manifested', 'transit');

create table return_labels (
  id              uuid primary key default gen_random_uuid(),
  repair_order_id uuid,      -- FK wird in 0010 ergänzt
  sales_order_id  uuid references sales_orders on delete set null,
  partner_id      uuid not null references partners on delete restrict,
  shipment_number text unique,
  label_path      text,
  qr_link         text,
  emailed_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
select attach_touch_trigger('return_labels');

/*
 * Lieferungen, die versandbereit sind: reserviert, noch nicht validiert und
 * ohne offene Fertigungsaufträge. Das ist die Arbeitsliste am Packtisch.
 */
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
    and not exists (
      select 1 from manufacturing_orders mo
      where mo.sales_order_id = so.id and mo.state not in ('done', 'cancel'));
