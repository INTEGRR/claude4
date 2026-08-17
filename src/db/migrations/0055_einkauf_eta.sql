-- BUG/00004 (Teil 1): ETA mit Lieferanten-Bestätigung und Trackingdetails an
-- der Bestellung. expected_arrival (Schätzung aus der Lieferzeit) existierte
-- schon; dazu kommen der vom Lieferanten BESTÄTIGTE Termin und die Sendung
-- (Carrier, Tracking-Nummer, Link) — gepflegt an der Bestellung, sichtbar am
-- Wareneingangs-Transfer und im Zulauf-Kalender des Lagers.

alter table purchase_orders
  add column eta_confirmed   date,   -- vom Lieferanten bestätigter Liefertermin
  add column carrier         text,   -- Frachtführer der Sendung
  add column tracking_number text,
  add column tracking_url    text;

comment on column purchase_orders.eta_confirmed is
  'Vom Lieferanten bestätigter Liefertermin — gilt vor expected_arrival (Schätzung).';

-- Der Termin gehört EINMAL gepflegt (an der Bestellung) und wandert von dort
-- an die offenen Wareneingangs-Transfers: der Lagerist plant nach
-- scheduled_date, ohne die Bestellung aufzuschlagen.
create or replace function purchase_order_eta_sync(p_order uuid)
returns void
language sql as $$
  update stock_pickings p
  set scheduled_date = coalesce(po.eta_confirmed::timestamptz, po.expected_arrival)
  from purchase_orders po
  where po.id = p_order
    and p.origin_model = 'purchase_order' and p.origin_id = po.id
    and p.state not in ('done', 'cancel')
    and coalesce(po.eta_confirmed::timestamptz, po.expected_arrival) is not null;
$$;

comment on function purchase_order_eta_sync is
  'Überträgt den Liefertermin der Bestellung (bestätigt vor geschätzt) auf die scheduled_date ihrer offenen Wareneingangs-Transfers.';
