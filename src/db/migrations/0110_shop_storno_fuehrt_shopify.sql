-- ============================================================================
-- 0110  Storno von Shop-Aufträgen führt Shopify (Betreiber 2026-10-02)
-- ----------------------------------------------------------------------------
-- KRNL storniert Shop-Aufträge nicht mehr selbst und meldet keinen Storno
-- mehr an Shopify (0047 ist damit zurückgenommen). Storniert und erstattet
-- wird im Shopify-Admin; der Webhook (orders/cancelled bzw. voll erstattet)
-- storniert den Auftrag hier und zieht alles Nachgelagerte mit:
-- offene Lieferungen samt Reservierungen, nicht begonnene Fertigung (wie
-- bisher, cancel_sales_order) und neu offene Druckaufträge sowie wartende
-- Shop-Rückmeldungen. DHL-Labels storniert der Code nach der Transaktion
-- (verkauf/storno-nachlauf.ts). Aufträge, die nicht aus dem Shop kommen,
-- storniert KRNL wie bisher selbst.
-- Entscheidungslog 2026-10-02.
-- ============================================================================

-- Prozess: Storno-Zweig je Herkunft.
--   manuell → Aktion „Stornieren" (wie bisher)
--   Shop    → Ereignis „In Shopify storniert"; kein Dienstschritt mehr
do $$
declare
  v_neu uuid;
  v_shop constant jsonb := '{"feld": "source", "op": "=", "wert": "shopify"}';
begin
  v_neu := prozess_version_kopieren('verkauf', 'migration:0110');

  -- DESTRUKTIV: entfernt nur Schritt und Kanten des Dienstschritts
  -- „Storno an den Shop melden" in der eben kopierten, noch inaktiven Version;
  -- ältere Versionen bleiben unverändert.
  delete from prozess_uebergaenge
  where version_id = v_neu and (von_code = 'shop_storno' or nach_code = 'shop_storno');
  delete from prozess_schritte where version_id = v_neu and code = 'shop_storno';

  update prozess_uebergaenge
  set bedingung = jsonb_build_object('nicht', v_shop), beschriftung = 'Abbruch'
  where version_id = v_neu and nach_code = 'stornieren';

  insert into prozess_schritte (version_id, code, name, art, sequence, ereignis, optional)
  values (v_neu, 'shop_storniert', 'In Shopify storniert', 'ereignis', 85,
          'shop:bestellung_storniert', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_neu, 'anlegen', 'shop_storniert', 95, v_shop, 'Storno im Shop'),
    (v_neu, 'bestaetigen', 'shop_storniert', 95, v_shop, 'Storno im Shop'),
    (v_neu, 'shop_storniert', 'ende', 10, null, null);

  perform prozess_version_aktivieren(v_neu);
end $$;

-- Storno: wie 0029, dazu Druckaufträge und wartende Shop-Rückmeldungen.
create or replace function cancel_sales_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql
set search_path = public, pg_temp as $$
declare
  o sales_orders%rowtype;
  p record;
  m record;
  v_fertig int;
  v_druck int;
  v_meldungen int;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'cancel' then return; end if;

  -- Offene Lieferungen stornieren (erledigte bleiben — Korrektur per Retoure).
  for p in
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  for m in
    select id, number from manufacturing_orders
    where sales_order_id = p_order and state not in ('done', 'cancel')
  loop
    if exists (select 1 from stock_moves
               where production_id = m.id and state = 'done') then
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s ist angebrochen (Material bereits entnommen) und bleibt bestehen — fertig bauen oder demontieren.', m.number),
        p_actor);
    else
      perform mo_cancel(m.id, p_actor);
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s storniert, Materialreservierungen freigegeben.', m.number),
        p_actor);
    end if;
  end loop;

  select count(*) into v_fertig from manufacturing_orders
  where sales_order_id = p_order and state = 'done';
  if v_fertig > 0 then
    perform log_event('sales_order', p_order, 'note',
      'Die fertige Ware aus der bereits erledigten Fertigung liegt im Bestand und ist wieder frei verfügbar.',
      p_actor);
  end if;

  -- Noch nicht gedruckte Labels, Packzettel und Fertigungszettel nicht mehr
  -- drucken (nur offene von stornierten Belegen; Gedrucktes bleibt Verlauf).
  update druckauftraege d
  set status = 'fehler', fehler = 'Auftrag storniert — nicht gedruckt'
  where d.status = 'offen'
    and (
      d.picking_id in (select id from stock_pickings
                       where origin_model = 'sales_order' and origin_id = p_order and state = 'cancel')
      or d.shipment_id in (select s.id from shipments s
                           join stock_pickings sp on sp.id = s.picking_id
                           where sp.origin_model = 'sales_order' and sp.origin_id = p_order
                             and sp.state = 'cancel')
      or d.mo_id in (select id from manufacturing_orders
                     where sales_order_id = p_order and state = 'cancel')
    );
  get diagnostics v_druck = row_count;
  if v_druck > 0 then
    perform log_event('sales_order', p_order, 'note',
      format('%s offene(r) Druckauftrag/-aufträge zurückgezogen.', v_druck), p_actor);
  end if;

  -- Wartende Shop-Rückmeldungen (Fulfillment) zu Sendungen des Auftrags
  -- nicht mehr senden — eine stornierte Shop-Bestellung nimmt keins an.
  update integration_jobs j
  set status = 'done', last_result = 'Übersprungen: Auftrag storniert', last_error = null, dedupe_key = null
  where j.status = 'pending' and j.kind = 'shopify_fulfillment_create'
    and (j.payload ->> 'shipment_id')::uuid in (
      select s.id from shipments s
      left join stock_pickings sp on sp.id = s.picking_id
      where s.sales_order_id = p_order
         or (sp.origin_model = 'sales_order' and sp.origin_id = p_order));
  get diagnostics v_meldungen = row_count;
  if v_meldungen > 0 then
    perform log_event('sales_order', p_order, 'note',
      format('%s wartende Shop-Rückmeldung(en) verworfen.', v_meldungen), p_actor);
  end if;

  update sales_orders set state = 'cancel', locked = false where id = p_order;
  perform log_event('sales_order', p_order, 'state', 'Auftrag storniert', p_actor);
end $$;
