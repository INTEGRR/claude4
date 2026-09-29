-- ============================================================================
-- 0089  Shopify: Netto-Umsätze und die ganze Verkaufshistorie
-- ----------------------------------------------------------------------------
-- Gefunden im Parallelbetrieb (2026-09-29): Die Erstübernahme brachte nur
-- rund 100 Bestellungen — ohne den geschützten Scope read_all_orders liefert
-- Shopify still nur die letzten 60 Tage. Die Historie der Vorjahre kommt
-- deshalb aus dem CSV-Export des Shop-Admins (Entscheidungslog 2026-09-29).
-- Dabei fiel auf: der Import speicherte den Brutto-Listenpreis VOR Rabatt
-- als Nettopreis — Umsätze waren um Steuer und Rabatte zu hoch.
--
--   * sales_orders.historisch: übernommene, abgeschlossene Aufträge ohne
--     Lieferung, Reservierung oder Fertigung. Sie stehen auf 'sale'/'full'
--     (bzw. 'cancel'); confirm_sales_order tut für 'sale' ohnehin nichts,
--     sie können also nie Logistik auslösen.
--   * sales_orders.versandkosten: Versandkosten netto nach Rabatt — getrennt
--     vom Warenumsatz (sales_order_total bleibt Warenumsatz).
-- ============================================================================

alter table sales_orders
  add column historisch boolean not null default false,
  add column versandkosten numeric(16,2) not null default 0;

comment on column sales_orders.historisch is
  'Historisch übernommen (Shopify-Export bzw. bei Import bereits versandt): keine Lieferung, Reservierung, Fertigung';
comment on column sales_orders.versandkosten is
  'Versandkosten netto nach Rabatt (aus Shopify); nicht Teil von sales_order_total (Warenumsatz)';

-- Doppel-Schutz des Historie-Imports über den Bestellnamen (#38690).
create index sales_orders_shopify_name_idx on sales_orders (shopify_order_name)
  where shopify_order_name is not null;

-- Bereits als „historisch übernommen" importierte Aufträge (Live-Import:
-- in Shopify schon versandt) nachziehen: Marke, Bestätigungsdatum, geliefert.
update sales_orders so
set historisch = true,
    confirmed_at = coalesce(so.confirmed_at, so.order_date)
where so.source = 'shopify' and so.state = 'sale' and so.delivery_status = 'full'
  and not exists (
    select 1 from stock_pickings p
    where p.origin_model = 'sales_order' and p.origin_id = so.id);

update sales_order_lines l
set qty_delivered = l.qty
from sales_orders so
where so.id = l.order_id and so.historisch
  and l.variant_id is not null and l.qty_delivered = 0;
