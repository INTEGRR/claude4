-- ===========================================================================
-- Odoo-Vervollständigung III: Belegfelder + Fachlogik
-- Verkauf, Einkauf, Rechnungen, Lager, Fertigung, Reparatur. Feldnamen
-- folgen den Odoo-18-Modellen; die Statuswerte aus 0013 werden hier aktiv.
-- ===========================================================================

-- --- Verkauf (sale.order / sale.order.line) --------------------------------
alter table sales_orders
  add column user_id uuid references users on delete set null,        -- Verkäufer
  add column client_order_ref text,                                   -- Kundenreferenz
  add column commitment_date timestamptz,                             -- zugesagter Liefertermin
  add column validity_date date,                                      -- Angebot gültig bis
  add column payment_term_id uuid references payment_terms on delete set null,
  add column incoterm_code text references incoterms on delete set null,
  add column incoterm_location text,
  add column origin text;                                             -- Quellbeleg

alter table sales_order_lines
  add column tax_id uuid references taxes on delete set null,
  add column invoice_status text not null default 'no'
    check (invoice_status in ('no', 'to_invoice', 'invoiced', 'upselling')),
  add column qty_to_invoice numeric(16,4) not null default 0,
  add column customer_lead numeric(16,2) not null default 0;          -- Vorlauf (Tage)

-- --- Einkauf (purchase.order / purchase.order.line) ------------------------
alter table purchase_orders
  add column user_id uuid references users on delete set null,        -- Einkäufer
  add column payment_term_id uuid references payment_terms on delete set null,
  add column incoterm_code text references incoterms on delete set null,
  add column origin text,
  add column priority text not null default '0' check (priority in ('0', '1')),
  add column receipt_reminder_email boolean not null default false,
  add column reminder_date_before_receipt int not null default 1,
  add column picking_type_id uuid references operation_types on delete set null;  -- "Deliver To"

alter table purchase_order_lines
  add column discount numeric(5,2) not null default 0,
  add column tax_id uuid references taxes on delete set null,
  add column date_planned timestamptz;

-- Summen rechnen jetzt mit Zeilenrabatt.
create or replace function purchase_line_subtotal(l purchase_order_lines) returns numeric
language sql immutable as $$
  select round(l.qty * l.price_unit * (1 - l.discount / 100), 2);
$$;

create or replace function purchase_order_total(p_order uuid)
returns table (net numeric, tax numeric, gross numeric)
language sql stable as $$
  select coalesce(sum(purchase_line_subtotal(l)), 0),
         coalesce(sum(round(purchase_line_subtotal(l) * l.tax_rate / 100, 2)), 0),
         coalesce(sum(purchase_line_subtotal(l)
                      + round(purchase_line_subtotal(l) * l.tax_rate / 100, 2)), 0)
  from purchase_order_lines l where l.order_id = p_order;
$$;

-- --- Lieferantenrechnungen (account.move, Ausschnitt) ----------------------
alter table vendor_bills
  add column payment_term_id uuid references payment_terms on delete set null,
  add column payment_reference text,                                  -- Verwendungszweck
  add column checked boolean not null default false,                  -- Prüf-Flag
  add column user_id uuid references users on delete set null;
alter table vendor_bill_lines
  add column tax_id uuid references taxes on delete set null;

-- 3-Way-Matching (Bestellung ↔ Wareneingang ↔ Rechnung) als Ampel:
--   yes       alle Rechnungspositionen durch Wareneingänge gedeckt
--   no        noch gar kein Wareneingang zu den berechneten Positionen
--   exception mehr berechnet als erhalten
create or replace function vendor_bill_match_state(p_bill uuid) returns text
language plpgsql stable as $$
declare
  v_lines int; v_gedeckt int; v_ohne_eingang int;
begin
  select count(*),
         count(*) filter (where pol.qty_received >= l.qty),
         count(*) filter (where pol.qty_received = 0)
    into v_lines, v_gedeckt, v_ohne_eingang
  from vendor_bill_lines l
  join purchase_order_lines pol on pol.id = l.po_line_id
  where l.bill_id = p_bill;

  if v_lines = 0 then return 'yes'; end if;  -- freie Rechnung ohne Bestellbezug
  if v_gedeckt = v_lines then return 'yes'; end if;
  if v_ohne_eingang = v_lines then return 'no'; end if;
  return 'exception';
end $$;

-- Beim Erstellen Zahlungsbedingung des Lieferanten und Zeilensteuer übernehmen.
create or replace function create_vendor_bill(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o purchase_orders%rowtype;
  v_bill uuid;
  l record;
  v_billable numeric;
  v_count int := 0;
begin
  select * into o from purchase_orders where id = p_order;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state not in ('purchase', 'done') then
    raise exception 'Nur bestätigte Bestellungen können abgerechnet werden';
  end if;

  insert into vendor_bills (number, purchase_order_id, vendor_id, currency, payment_term_id)
  values (next_sequence('bill'), o.id, o.vendor_id, o.currency,
          coalesce(o.payment_term_id,
                   (select supplier_payment_term_id from partners where id = o.vendor_id)))
  returning id into v_bill;

  for l in
    select pol.*, pt.bill_policy
    from purchase_order_lines pol
    join product_variants pv on pv.id = pol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where pol.order_id = p_order
  loop
    v_billable := (case when l.bill_policy = 'ordered' then l.qty else l.qty_received end) - l.qty_billed;
    if v_billable > 0 then
      insert into vendor_bill_lines (bill_id, po_line_id, name, qty, price_unit, tax_rate, tax_id)
      values (v_bill, l.id, l.name, v_billable,
              round(l.price_unit * (1 - l.discount / 100), 2), l.tax_rate, l.tax_id);
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    delete from vendor_bills where id = v_bill;
    raise exception 'Nichts abzurechnen. Bei der Politik "nach erhaltener Menge" muss zuerst der Wareneingang gebucht werden.';
  end if;

  perform log_event('purchase_order', p_order, 'note',
    'Entwurfsrechnung erstellt: ' || (select number from vendor_bills where id = v_bill), p_actor);
  return v_bill;
end $$;

-- Beim Buchen die Fälligkeit aus der Zahlungsbedingung ableiten.
create or replace function post_vendor_bill(p_bill uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  b vendor_bills%rowtype;
  l record;
begin
  select * into b from vendor_bills where id = p_bill for update;
  if b.id is null then raise exception 'Rechnung nicht gefunden'; end if;
  if b.state <> 'draft' then raise exception 'Nur Entwurfsrechnungen können gebucht werden'; end if;
  if b.bill_date is null then raise exception 'Bitte zuerst das Rechnungsdatum erfassen'; end if;

  for l in select * from vendor_bill_lines where bill_id = p_bill and po_line_id is not null loop
    update purchase_order_lines
      set qty_billed = qty_billed + (case when b.is_credit_note then -l.qty else l.qty end)
    where id = l.po_line_id;
  end loop;

  update vendor_bills set
    state = 'posted',
    due_date = coalesce(b.due_date,
                        payment_term_due_date(b.payment_term_id, b.bill_date),
                        b.bill_date)
  where id = p_bill;

  if b.purchase_order_id is not null then
    perform purchase_order_recompute_billing(b.purchase_order_id);
  end if;
  perform log_event('vendor_bill', p_bill, 'state', 'Rechnung gebucht', p_actor);
end $$;

-- --- Lager (stock.picking / stock.move / stock.location / picking.type) ----
alter table stock_pickings
  add column user_id uuid references users on delete set null,        -- Responsible
  add column priority text not null default '0' check (priority in ('0', '1')),
  add column move_type text not null default 'direct'
    check (move_type in ('direct', 'one'));                           -- Teil-/Komplettlieferung

alter table stock_moves
  add column move_dest_id uuid references stock_moves on delete set null,  -- MTO-Kette (1:n-Minimalform)
  add column propagate_cancel boolean not null default true;
create index stock_moves_dest_idx on stock_moves (move_dest_id) where move_dest_id is not null;

alter table stock_locations
  add column removal_strategy text
    check (removal_strategy in ('fifo', 'lifo', 'closest')),
  add column cyclic_inventory_frequency int,                          -- Tage; zyklische Inventur
  add column last_inventory_date date,
  add column next_inventory_date date;

alter table operation_types
  add column reservation_days_before int;                             -- für reservation='by_date'

-- --- Fertigung (mrp.production / mrp.bom) ----------------------------------
alter table manufacturing_orders
  add column user_id uuid references users on delete set null,
  add column origin text,
  add column priority text not null default '0' check (priority in ('0', '1'));

alter table boms
  add column produce_delay int not null default 0,                    -- Fertigungsdauer (Tage)
  add column days_to_prepare_mo int not null default 0;

-- Kit-Stücklisten bekommen einen eigenen Resolver (resolve_bom liefert
-- bewusst nur 'manufacture').
create or replace function resolve_kit(p_variant uuid) returns uuid
language sql stable as $$
  select b.id
  from boms b
  join product_variants pv on pv.template_id = b.template_id
  where pv.id = p_variant and b.active and b.bom_type = 'kit'
  order by (b.variant_id = p_variant) desc nulls last, b.variant_id nulls last, b.created_at
  limit 1;
$$;

-- --- Reparatur (repair.order) ----------------------------------------------
alter table repair_orders
  add column user_id uuid references users on delete set null,
  add column operation_type_id uuid references operation_types on delete set null,
  add column priority text not null default '0' check (priority in ('0', '1'));
comment on column repair_orders.responsible is
  'Veraltet — ersetzt durch user_id (0014).';

update repair_orders set operation_type_id =
  (select id from operation_types where kind = 'repair' limit 1)
where operation_type_id is null;

-- --- Verkaufsstatus: started/upselling + Zeilenstatus ----------------------
create or replace function sales_order_recompute_status(p_order uuid) returns void
language plpgsql as $$
declare
  v_total numeric; v_delivered numeric; v_invoiced numeric;
  v_state sale_state;
  v_started boolean;
  v_to_invoice int; v_upselling int; v_invoiced_lines int; v_lines int;
begin
  select state into v_state from sales_orders where id = p_order;

  select coalesce(sum(l.qty), 0), coalesce(sum(l.qty_delivered), 0), coalesce(sum(l.qty_invoiced), 0)
    into v_total, v_delivered, v_invoiced
  from sales_order_lines l where l.order_id = p_order and l.display_type is null;

  -- 'started': das Lager hat begonnen (Lieferung reserviert), aber noch
  -- nichts ist beim Kunden.
  select exists (
    select 1 from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    where p.origin_model = 'sales_order' and p.origin_id = p_order
      and ot.kind = 'delivery' and p.state = 'assigned')
    into v_started;

  update sales_orders set delivery_status = case
      when v_delivered >= v_total and v_total > 0 then 'full'::delivery_status
      when v_delivered > 0 then 'partial'::delivery_status
      when v_started then 'started'::delivery_status
      else 'pending'::delivery_status
    end
  where id = p_order;

  -- Zeilenstatus + abzurechnende Menge (Odoo: qty_to_invoice/invoice_status
  -- je sale.order.line; 'upselling' = mehr geliefert als bestellt und
  -- Bestellmenge bereits berechnet).
  update sales_order_lines l set
    qty_to_invoice = case
      when v_state <> 'sale' then 0
      else greatest(
        (case when pt.invoice_policy = 'delivery' then l.qty_delivered else l.qty end)
          - l.qty_invoiced, 0)
    end,
    invoice_status = case
      when v_state <> 'sale' then 'no'
      when pt.invoice_policy = 'delivery' and l.qty_delivered > l.qty
           and l.qty_invoiced >= l.qty then 'upselling'
      when (case when pt.invoice_policy = 'delivery' then l.qty_delivered else l.qty end)
             > l.qty_invoiced then 'to_invoice'
      when l.qty_invoiced > 0 then 'invoiced'
      else 'no'
    end
  from product_variants pv
  join product_templates pt on pt.id = pv.template_id
  where l.order_id = p_order and l.display_type is null and pv.id = l.variant_id;

  select count(*),
         count(*) filter (where l.invoice_status = 'to_invoice'),
         count(*) filter (where l.invoice_status = 'upselling'),
         count(*) filter (where l.invoice_status = 'invoiced')
    into v_lines, v_to_invoice, v_upselling, v_invoiced_lines
  from sales_order_lines l where l.order_id = p_order and l.display_type is null;

  update sales_orders set invoice_status = case
      when v_state <> 'sale' then 'no'::invoice_status
      when v_to_invoice > 0 then 'to_invoice'::invoice_status
      when v_upselling > 0 then 'upselling'::invoice_status
      when v_invoiced_lines = v_lines and v_lines > 0 then 'invoiced'::invoice_status
      else 'no'::invoice_status
    end
  where id = p_order;
end $$;

-- --- Auftragsbestätigung: Kits, Terminierung, Steuer-Schnappschuss ---------
create or replace function confirm_sales_order(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o sales_orders%rowtype;
  v_op operation_types%rowtype;
  v_picking uuid;
  l record;
  c record;
  v_kit uuid;
  v_kit_qty numeric;
  v_count int := 0;
  v_mo uuid;
  v_mo_count int := 0;
  v_scheduled timestamptz;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'sale' then return null; end if;
  if o.state = 'cancel' then raise exception 'Stornierte Aufträge können nicht bestätigt werden'; end if;

  -- Steuer-Schnappschuss: Satz aus der Zeilensteuer bzw. dem Produkt-Default.
  -- (Alias "zeile": ein Alias "l" würde mit der Schleifenvariable kollidieren.)
  update sales_order_lines zeile set
    tax_id = coalesce(zeile.tax_id, pt.sale_tax_id),
    tax_rate = coalesce(
      (select amount from taxes where id = coalesce(zeile.tax_id, pt.sale_tax_id)), zeile.tax_rate)
  from product_variants pv
  join product_templates pt on pt.id = pv.template_id
  where zeile.order_id = p_order and zeile.display_type is null and pv.id = zeile.variant_id;

  -- Terminierung: zugesagter Termin, sonst heute + längste Kundenlieferzeit.
  select coalesce(o.commitment_date,
                  now() + make_interval(days => coalesce(max(pt.sale_delay), 0)))
    into v_scheduled
  from sales_order_lines sol
  join product_variants pv on pv.id = sol.variant_id
  join product_templates pt on pt.id = pv.template_id
  where sol.order_id = p_order and sol.display_type is null;

  select * into v_op from operation_types where kind = 'delivery' and active limit 1;

  insert into stock_pickings (
    number, operation_type_id, state, partner_id, scheduled_date,
    origin_model, origin_id, origin_label)
  values (
    next_sequence(v_op.sequence_code), v_op.id, 'draft', o.partner_id,
    coalesce(v_scheduled, now()),
    'sales_order', o.id, o.number)
  returning id into v_picking;

  for l in
    select sol.*, pt.type as product_type, pt.route_manufacture, pt.route_mto
    from sales_order_lines sol
    join product_variants pv on pv.id = sol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where sol.order_id = p_order and sol.display_type is null and sol.qty > 0
  loop
    if l.product_type = 'goods' then
      v_kit := resolve_kit(l.variant_id);
      if v_kit is not null then
        -- Kit-Stückliste: die Komponenten werden geliefert, nicht das Set
        -- (mrp: bom_type='phantom'). Variantenfilter gelten wie bei der
        -- Fertigung.
        select qty into v_kit_qty from boms where id = v_kit;
        for c in select * from bom_components_for_variant(v_kit, l.variant_id) loop
          insert into stock_moves (
            picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
            state, reference)
          values (
            v_picking, c.component_variant_id, c.uom_id,
            round(c.qty * l.qty / v_kit_qty, 4),
            v_op.default_src_id, v_op.default_dest_id, 'draft', 'Kit: ' || l.name);
          v_count := v_count + 1;
        end loop;
      else
        insert into stock_moves (
          picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
        values (
          v_picking, l.variant_id, l.uom_id, l.qty,
          v_op.default_src_id, v_op.default_dest_id, 'draft');
        v_count := v_count + 1;
      end if;
    end if;

    -- Route "Fertigen auf Bestellung": je Position ein Fertigungsauftrag.
    -- MTO beschafft auftragsbezogen, auch wenn Bestand vorhanden ist.
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      v_mo := create_manufacturing_order(l.variant_id, l.qty, p_order, null, p_actor);
      update manufacturing_orders set origin = o.number where id = v_mo;
      perform mo_confirm(v_mo, p_actor);
      v_mo_count := v_mo_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    delete from stock_pickings where id = v_picking;
    v_picking := null;
  else
    perform picking_confirm(v_picking);
  end if;

  update sales_orders
    set state = 'sale', confirmed_at = now(),
        locked = coalesce((select (value ->> 'lock_confirmed')::boolean from settings where key = 'sales'), false)
  where id = p_order;

  perform sales_order_recompute_status(p_order);
  perform log_event('sales_order', p_order, 'state',
    format('Auftrag bestätigt (%s Lieferposition(en), %s Fertigungsauftrag/-aufträge)',
           v_count, v_mo_count), p_actor);
  return v_picking;
end $$;
