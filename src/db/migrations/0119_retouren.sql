-- ============================================================================
-- 0119 — Retouren als Prozess (Entscheidungslog 2026-10-17)
--
-- Kunde will die gelieferte Ware nicht: Anfrage (Portal im Shop oder intern)
-- → Genehmigung mit DHL-Retourenlabel → Eingang per Scan → Prüfung je
-- Position (verkaufsfähig / B-Ware / defekt) mit Rückbuchung → Erstattung im
-- Shopify-Admin (KRNL erkennt sie am Bestell-Webhook) → Abschluss: nicht
-- begonnene Fertigung, deren Lieferung der Rückläufer jetzt deckt, entfällt,
-- das Team Fertigung bekommt Bescheid. Nur Shop-Aufträge.
--
--  * retoure_status, retouren, retoure_positionen, return_labels.retoure_id
--  * Nummernkreis RT/, Lagerort WH/B-Ware (nicht verkaufsrelevant: kein
--    internal-Ort, zählt weder im freien Bestand noch für Shopify; keine
--    Demontage — B-Ware und Defekt werden nur markiert)
--  * retoure_anlegen / _genehmigen / _ablehnen / _eingang / _pruefen /
--    _erstattet / _abschliessen / _stornieren
--  * confirm_sales_order: verkaufsfähige Rückläufer decken MTO zuerst (nur
--    sie — die Regel „MTO fertigt auch bei Bestand" bleibt sonst bestehen)
--  * Prozess „retoure" (Bereich Versand), Einrichtungsaufgabe Portal-Link
-- ============================================================================

create type retoure_status as enum
  ('angefragt', 'genehmigt', 'abgelehnt', 'eingegangen', 'geprueft', 'abgeschlossen', 'storniert');

insert into sequences (code, prefix, padding, next_number)
select 'retoure', 'RT/', 5, 1
where not exists (select 1 from sequences where code = 'retoure');

-- B-Ware/Defekt: unter WH, aber Typ inventory_loss — damit bleibt die Ware aus
-- free_to_use/on_hand_qty (nur 'internal'), aus der Reservierung und aus der
-- Shop-Menge. Der Pfad „WH/B-Ware" sortiert hinter „Virtuell/…", die Suche
-- nach dem Inventurdifferenz-Ort (inventory_apply: erster nicht-Ausschuss-Ort
-- dieses Typs nach full_path) findet weiter „Virtuell/Inventurdifferenz".
insert into stock_locations (warehouse_id, parent_id, name, type, barcode)
select w.id, l.id, 'B-Ware', 'inventory_loss', 'LOC-WH-BWARE'
from warehouses w join stock_locations l on l.warehouse_id = w.id and l.name = 'WH' and l.type = 'view'
where w.code = 'WH'
  and not exists (select 1 from stock_locations where barcode = 'LOC-WH-BWARE');

create table retouren (
  id                 uuid primary key default gen_random_uuid(),
  nummer             text unique not null,
  status             retoure_status not null default 'angefragt',
  sales_order_id     uuid not null references sales_orders on delete restrict,
  partner_id         uuid not null references partners on delete restrict,
  quelle             text not null default 'intern' check (quelle in ('intern', 'shop')),
  email              text,
  grund              text,
  ablehnungsgrund    text,
  notiz              text,
  absender_hash      text,
  shop_brutto_vorher numeric(16,2),
  picking_id         uuid references stock_pickings on delete set null,
  fertigung_info     text,
  genehmigt_am       timestamptz,
  eingegangen_am     timestamptz,
  geprueft_am        timestamptz,
  erstattet_am       timestamptz,
  abgeschlossen_am   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
select attach_touch_trigger('retouren');
create index retouren_order_idx on retouren (sales_order_id);
create index retouren_status_idx on retouren (status);
create index retouren_absender_idx on retouren (absender_hash, created_at) where absender_hash is not null;
comment on table retouren is
  'Rücksendungen gelieferter Shop-Ware (0119): Anfrage → Genehmigung + Label → Eingang → Prüfung mit Rückbuchung → Erstattung im Shop → Abschluss.';
comment on column retouren.shop_brutto_vorher is
  'Gesamtbetrag laut Shop bei der Anfrage — sinkt er danach, hat der Shop erstattet (Erkennung am Webhook).';

create table retoure_positionen (
  id                  uuid primary key default gen_random_uuid(),
  retoure_id          uuid not null references retouren on delete cascade,
  sequence            int not null default 10,
  sales_order_line_id uuid references sales_order_lines on delete set null,
  variant_id          uuid not null references product_variants on delete restrict,
  bezeichnung         text not null,
  menge               numeric(16,4) not null check (menge > 0),
  grund               text,
  pruefung            text check (pruefung in ('verkaufsfaehig', 'bware', 'defekt')),
  pruef_notiz         text,
  wiederverwendet     numeric(16,4) not null default 0 check (wiederverwendet >= 0)
);
comment on column retoure_positionen.wiederverwendet is
  'Wie viel der verkaufsfähig zurückgebuchten Menge schon einen Auftrag deckt (Fertigung entfallen oder bei der Bestätigung nicht angelegt).';
create index retoure_positionen_idx on retoure_positionen (retoure_id, sequence);
create index retoure_positionen_zeile_idx on retoure_positionen (sales_order_line_id);

alter table return_labels add column retoure_id uuid references retouren on delete set null;
create index return_labels_retoure_idx on return_labels (retoure_id);

-- --- Anlegen -----------------------------------------------------------------------
/*
 * Retoure zu einem gelieferten Shop-Auftrag. p_positionen:
 * [{"zeile": <sales_order_line_id>, "menge": n, "grund": "…"}]. Je Zeile höchstens
 * die gelieferte Menge abzüglich dessen, was schon in offenen oder erledigten
 * Retouren steckt (abgelehnte und stornierte zählen nicht).
 */
create or replace function retoure_anlegen(
  p_order uuid, p_positionen jsonb, p_quelle text default 'intern', p_grund text default null,
  p_email text default null, p_absender_hash text default null, p_actor text default 'system'
) returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  o       sales_orders%rowtype;
  v_id    uuid;
  v_nr    text;
  v_seq   int := 10;
  v_frei  numeric;
  p       jsonb;
  l       record;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Auftrag nicht gefunden'; end if;
  if o.source <> 'shopify' then raise exception 'Retouren gibt es nur für Shop-Aufträge'; end if;
  if jsonb_typeof(p_positionen) <> 'array' or jsonb_array_length(p_positionen) = 0 then
    raise exception 'Bitte mindestens eine Position mit Menge angeben';
  end if;

  v_nr := next_sequence('retoure');
  insert into retouren (nummer, sales_order_id, partner_id, quelle, email, grund, absender_hash, shop_brutto_vorher)
  values (v_nr, o.id, o.partner_id, coalesce(p_quelle, 'intern'), nullif(trim(coalesce(p_email, '')), ''),
          nullif(trim(coalesce(p_grund, '')), ''), p_absender_hash, o.shopify_brutto)
  returning id into v_id;

  for p in select * from jsonb_array_elements(p_positionen) loop
    continue when coalesce((p ->> 'menge')::numeric, 0) <= 0;
    select sol.id, sol.variant_id, sol.name, sol.qty_delivered,
           coalesce((select sum(rp.menge) from retoure_positionen rp
                     join retouren r on r.id = rp.retoure_id
                     where rp.sales_order_line_id = sol.id and r.id <> v_id
                       and r.status not in ('abgelehnt', 'storniert')), 0) as schon
      into l
    from sales_order_lines sol
    where sol.id = (p ->> 'zeile')::uuid and sol.order_id = o.id and sol.variant_id is not null;
    if l.id is null then raise exception 'Position gehört nicht zum Auftrag %', o.number; end if;
    v_frei := l.qty_delivered - l.schon;
    if (p ->> 'menge')::numeric > v_frei then
      raise exception '%: höchstens % zurücksendbar (geliefert %, schon in Retouren %)',
        l.name, trim_scale(greatest(v_frei, 0)), trim_scale(l.qty_delivered), trim_scale(l.schon);
    end if;
    insert into retoure_positionen (retoure_id, sequence, sales_order_line_id, variant_id, bezeichnung, menge, grund)
    values (v_id, v_seq, l.id, l.variant_id, l.name, (p ->> 'menge')::numeric, nullif(trim(coalesce(p ->> 'grund', '')), ''));
    v_seq := v_seq + 10;
  end loop;

  if v_seq = 10 then raise exception 'Bitte mindestens eine Position mit Menge angeben'; end if;
  perform log_event('retoure', v_id, 'state',
    format('Retoure %s angefragt (%s)', v_nr, case coalesce(p_quelle, 'intern') when 'shop' then 'Portal im Shop' else 'intern' end), p_actor);
  perform log_event('sales_order', o.id, 'note', format('Retoure %s angefragt', v_nr), p_actor);
  return v_id;
end $$;

-- --- Statuswechsel -------------------------------------------------------------------
create or replace function retoure_status_setzen(
  p_id uuid, p_von retoure_status[], p_nach retoure_status, p_text text, p_actor text
) returns retouren
language plpgsql
set search_path = public, pg_temp as $$
declare r retouren%rowtype;
begin
  select * into r from retouren where id = p_id for update;
  if r.id is null then raise exception 'Retoure nicht gefunden'; end if;
  if not (r.status = any(p_von)) then
    raise exception 'Retoure % steht auf „%" — dieser Schritt geht nur aus %', r.nummer, r.status, array_to_string(p_von, ', ');
  end if;
  update retouren set status = p_nach,
         genehmigt_am   = case when p_nach = 'genehmigt'   then now() else genehmigt_am end,
         eingegangen_am = case when p_nach = 'eingegangen' then now() else eingegangen_am end,
         geprueft_am    = case when p_nach = 'geprueft'    then now() else geprueft_am end,
         abgeschlossen_am = case when p_nach = 'abgeschlossen' then now() else abgeschlossen_am end
   where id = p_id
  returning * into r;
  perform log_event('retoure', p_id, 'state', p_text, p_actor);
  return r;
end $$;

create or replace function retoure_genehmigen(p_id uuid, p_actor text default 'system') returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform retoure_status_setzen(p_id, '{angefragt}', 'genehmigt', 'Genehmigt', p_actor);
end $$;

create or replace function retoure_ablehnen(p_id uuid, p_grund text, p_actor text default 'system') returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  update retouren set ablehnungsgrund = nullif(trim(coalesce(p_grund, '')), '') where id = p_id;
  perform retoure_status_setzen(p_id, '{angefragt}', 'abgelehnt',
    'Abgelehnt' || coalesce(' — ' || nullif(trim(coalesce(p_grund, '')), ''), ''), p_actor);
end $$;

create or replace function retoure_eingang(p_id uuid, p_actor text default 'system') returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform retoure_status_setzen(p_id, '{angefragt,genehmigt}', 'eingegangen', 'Ware eingegangen', p_actor);
end $$;

create or replace function retoure_stornieren(p_id uuid, p_grund text default null, p_actor text default 'system') returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform retoure_status_setzen(p_id, '{angefragt,genehmigt}', 'storniert',
    'Storniert' || coalesce(' — ' || nullif(trim(coalesce(p_grund, '')), ''), ''), p_actor);
end $$;

-- --- Prüfen und zurückbuchen -------------------------------------------------------
/*
 * p_ergebnisse: [{"position": <id>, "pruefung": "verkaufsfaehig"|"bware"|"defekt",
 * "notiz": "…"}] — jede Position braucht ein Ergebnis. Gebucht wird ein
 * Rück-Transfer (Vorgangsart Wareneingang, Herkunft die Retoure, Rückbezug auf
 * die Lieferung) von „Partner/Kunden" nach WH/Stock (verkaufsfähig, ab sofort
 * verkaufbar und für wartende Lieferungen reservierbar) bzw. WH/B-Ware.
 * Hat der Shop schon erstattet, schließt die Prüfung die Retoure gleich ab.
 */
create or replace function retoure_pruefen(p_id uuid, p_ergebnisse jsonb, p_actor text default 'system')
returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  r          retouren%rowtype;
  v_op       operation_types%rowtype;
  v_kunden   uuid;
  v_lager    uuid;
  v_bware    uuid;
  v_picking  uuid;
  v_ergebnis text;
  v_fehlend  int;
  pos        record;
begin
  select * into r from retouren where id = p_id for update;
  if r.id is null then raise exception 'Retoure nicht gefunden'; end if;
  if r.status <> 'eingegangen' then
    raise exception 'Retoure % steht auf „%" — geprüft wird nach dem Eingang', r.nummer, r.status;
  end if;

  update retoure_positionen rp
     set pruefung = e ->> 'pruefung', pruef_notiz = nullif(trim(coalesce(e ->> 'notiz', '')), '')
    from jsonb_array_elements(coalesce(p_ergebnisse, '[]'::jsonb)) e
   where rp.retoure_id = p_id and rp.id = (e ->> 'position')::uuid
     and e ->> 'pruefung' in ('verkaufsfaehig', 'bware', 'defekt');
  select count(*) into v_fehlend from retoure_positionen where retoure_id = p_id and pruefung is null;
  if v_fehlend > 0 then raise exception 'Bitte jede Position prüfen (% ohne Ergebnis)', v_fehlend; end if;

  select * into v_op from operation_types where kind = 'receipt' and active order by created_at limit 1;
  select id into v_kunden from stock_locations where full_path = 'Partner/Kunden';
  select id into v_lager from stock_locations where full_path = 'WH/Stock';
  select id into v_bware from stock_locations where barcode = 'LOC-WH-BWARE';

  insert into stock_pickings (number, operation_type_id, state, partner_id, scheduled_date,
                              origin_model, origin_id, origin_label, return_of_id, note)
  values (next_sequence(v_op.sequence_code), v_op.id, 'draft', r.partner_id, now(),
          'retoure', r.id, r.nummer,
          (select p.id from stock_pickings p join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
           where p.origin_model = 'sales_order' and p.origin_id = r.sales_order_id and p.state = 'done'
           order by p.date_done desc nulls last limit 1),
          'Rücksendung ' || r.nummer)
  returning id into v_picking;

  for pos in
    select rp.*, pt.uom_id from retoure_positionen rp
    join product_variants pv on pv.id = rp.variant_id
    join product_templates pt on pt.id = pv.template_id
    where rp.retoure_id = p_id order by rp.sequence
  loop
    insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state, reference)
    values (v_picking, pos.variant_id, pos.uom_id, pos.menge, v_kunden,
            case when pos.pruefung = 'verkaufsfaehig' then v_lager else v_bware end, 'draft',
            r.nummer || ' — ' || case pos.pruefung when 'verkaufsfaehig' then 'verkaufsfähig' when 'bware' then 'B-Ware' else 'defekt' end);
  end loop;
  perform picking_confirm(v_picking);
  perform picking_validate(v_picking, '{}'::jsonb, false);
  -- Die Live-Reservierung (0086) läuft sonst erst am Transaktionsende — der
  -- Abschluss in derselben Transaktion (Shop hat schon erstattet) muss die
  -- jetzt gedeckten Lieferungen aber schon sehen.
  for pos in select distinct variant_id from retoure_positionen where retoure_id = p_id and pruefung = 'verkaufsfaehig' loop
    perform wartende_bewegungen_reservieren(pos.variant_id, v_lager);
  end loop;

  update retouren set picking_id = v_picking where id = p_id;
  select string_agg(format('%s × %s %s', rp.menge, rp.bezeichnung,
           case rp.pruefung when 'verkaufsfaehig' then 'verkaufsfähig → Lager' when 'bware' then 'B-Ware' else 'defekt → B-Ware' end), '; ' order by rp.sequence)
    into v_ergebnis from retoure_positionen rp where rp.retoure_id = p_id;
  perform retoure_status_setzen(p_id, '{eingegangen}', 'geprueft', 'Geprüft und zurückgebucht: ' || v_ergebnis, p_actor);
  perform log_event('sales_order', r.sales_order_id, 'note', format('Retoure %s geprüft: %s', r.nummer, v_ergebnis), p_actor);

  if r.erstattet_am is not null then
    perform retoure_abschliessen(p_id, p_actor);
  end if;
  return v_picking;
end $$;

-- --- Abschluss: Fertigung schließen ----------------------------------------------------
/*
 * Nur aus „geprüft". Für jede verkaufsfähig zurückgebuchte Variante: nicht
 * begonnene Fertigungsaufträge (Entwurf/bestätigt, nichts gefertigt) zu
 * Aufträgen, deren offene Lieferung dieser Variante jetzt vollständig
 * reserviert ist, entfallen — höchstens so viel, wie zurückkam, ältester
 * Termin zuerst. Das Team Fertigung bekommt eine Aufgabe. Bereits begonnene
 * Fertigung bleibt (Hinweis). Ohne wartende Lieferung liegt der Rückläufer
 * frei im Lager und bedient den nächsten Auftrag ohne Fertigung
 * (confirm_sales_order). Ohne erkannte Erstattung gilt der Aufruf als
 * Bestätigung von Hand.
 */
create or replace function retoure_abschliessen(p_id uuid, p_actor text default 'system')
returns text
language plpgsql
set search_path = public, pg_temp as $$
declare
  r          retouren%rowtype;
  v          record;
  m          record;
  v_rest     numeric;
  v_entfallen text[] := '{}';
  v_begonnen  text[] := '{}';
  v_info     text;
begin
  select * into r from retouren where id = p_id for update;
  if r.id is null then raise exception 'Retoure nicht gefunden'; end if;
  if r.status <> 'geprueft' then
    raise exception 'Retoure % steht auf „%" — abgeschlossen wird nach der Prüfung', r.nummer, r.status;
  end if;
  if r.erstattet_am is null then
    update retouren set erstattet_am = now() where id = p_id;
    perform log_event('retoure', p_id, 'note', 'Erstattung im Shop von Hand bestätigt', p_actor);
  end if;

  for v in
    select rp.variant_id, sum(rp.menge) as menge
    from retoure_positionen rp where rp.retoure_id = p_id and rp.pruefung = 'verkaufsfaehig'
    group by rp.variant_id
  loop
    v_rest := v.menge;
    for m in
      select mo.id, mo.number, mo.qty_to_produce, mo.state::text as state, mo.qty_produced, mo.date_start,
             so.id as auftrag_id, so.number as auftrag,
             (select coalesce(sum(sm.qty), 0) <= coalesce(sum(sm.reserved_qty), 0) and count(*) > 0
              from stock_moves sm join stock_pickings sp on sp.id = sm.picking_id
              join operation_types ot on ot.id = sp.operation_type_id and ot.kind = 'delivery'
              where sp.origin_model = 'sales_order' and sp.origin_id = so.id
                and sm.variant_id = v.variant_id and sm.state not in ('done', 'cancel')) as gedeckt
      from manufacturing_orders mo
      join sales_orders so on so.id = mo.sales_order_id
      where mo.variant_id = v.variant_id and mo.state not in ('done', 'cancel')
      order by mo.scheduled_date nulls last, mo.created_at
    loop
      exit when v_rest <= 0;
      continue when not m.gedeckt;
      if m.state in ('draft', 'confirmed') and m.date_start is null and coalesce(m.qty_produced, 0) = 0
         and m.qty_to_produce <= v_rest then
        perform mo_cancel(m.id, p_actor);
        perform ruecklaeufer_verbrauchen(v.variant_id, m.qty_to_produce);
        perform log_event('manufacturing_order', m.id, 'note',
          format('Entfällt: Rückläufer aus Retoure %s deckt Auftrag %s', r.nummer, m.auftrag), p_actor);
        perform log_event('sales_order', m.auftrag_id, 'note',
          format('Fertigung %s entfällt — Rückläufer aus Retoure %s liegt für die Lieferung bereit', m.number, r.nummer), p_actor);
        v_entfallen := v_entfallen || format('%s (Auftrag %s)', m.number, m.auftrag);
        v_rest := v_rest - m.qty_to_produce;
      elsif m.state not in ('draft', 'confirmed') or m.date_start is not null then
        v_begonnen := v_begonnen || format('%s (Auftrag %s)', m.number, m.auftrag);
      end if;
    end loop;
  end loop;

  v_info := concat_ws(' · ',
    case when cardinality(v_entfallen) > 0 then 'Fertigung entfällt: ' || array_to_string(v_entfallen, ', ') end,
    case when cardinality(v_begonnen) > 0 then 'schon begonnen, bitte prüfen: ' || array_to_string(v_begonnen, ', ') end,
    case when cardinality(v_entfallen) = 0 and cardinality(v_begonnen) = 0
              and exists (select 1 from retoure_positionen where retoure_id = p_id and pruefung = 'verkaufsfaehig')
         then 'keine wartende Fertigung — der Rückläufer liegt frei im Lager und bedient den nächsten Auftrag ohne Fertigung' end);

  if cardinality(v_entfallen) > 0 or cardinality(v_begonnen) > 0 then
    insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von)
    values (format('Retoure %s: Fertigung anpassen', r.nummer),
            v_info || '. Der geprüfte Rückläufer ist verkaufsfähig zurückgebucht und für die Lieferung reserviert.',
            'fertigung', (now() at time zone 'Europe/Berlin')::date, p_actor);
  end if;

  update retouren set fertigung_info = nullif(v_info, '') where id = p_id;
  perform retoure_status_setzen(p_id, '{geprueft}', 'abgeschlossen',
    'Abgeschlossen' || coalesce(' — ' || nullif(v_info, ''), ''), p_actor);
  return coalesce(nullif(v_info, ''), 'Retoure abgeschlossen');
end $$;

-- --- Erstattung im Shop erkannt ---------------------------------------------------------
create or replace function retoure_erstattet(p_id uuid, p_actor text default 'shopify')
returns void
language plpgsql
set search_path = public, pg_temp as $$
declare r retouren%rowtype;
begin
  select * into r from retouren where id = p_id for update;
  if r.id is null or r.erstattet_am is not null then return; end if;
  if r.status in ('abgelehnt', 'storniert', 'abgeschlossen') then return; end if;
  update retouren set erstattet_am = now() where id = p_id;
  perform log_event('retoure', p_id, 'note', 'Erstattung im Shop erkannt', p_actor);
  if r.status = 'geprueft' then perform retoure_abschliessen(p_id, p_actor); end if;
end $$;

-- --- Rückläufer-Konto ---------------------------------------------------------------------
-- Verkaufsfähig geprüfte, noch nicht wiederverwendete Retouren-Menge je Variante.
-- Nur DIESE Menge ersetzt Fertigung — gewöhnlicher Fertigbestand nicht (die
-- Regel „Made-to-Order fertigt auftragsbezogen, auch bei Bestand" bleibt).
create or replace function ruecklaeufer_frei(p_variant uuid) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(rp.menge - rp.wiederverwendet), 0)
  from retoure_positionen rp join retouren r on r.id = rp.retoure_id
  where rp.variant_id = p_variant and rp.pruefung = 'verkaufsfaehig'
    and r.status in ('geprueft', 'abgeschlossen');
$$;

create or replace function ruecklaeufer_verbrauchen(p_variant uuid, p_menge numeric) returns numeric
language plpgsql set search_path = public, pg_temp as $$
declare
  v_rest numeric := p_menge;
  pos    record;
  v_teil numeric;
begin
  for pos in
    select rp.id, rp.menge - rp.wiederverwendet as frei
    from retoure_positionen rp join retouren r on r.id = rp.retoure_id
    where rp.variant_id = p_variant and rp.pruefung = 'verkaufsfaehig'
      and r.status in ('geprueft', 'abgeschlossen') and rp.menge > rp.wiederverwendet
    order by r.geprueft_am, rp.sequence
    for update of rp
  loop
    exit when v_rest <= 0;
    v_teil := least(v_rest, pos.frei);
    update retoure_positionen set wiederverwendet = wiederverwendet + v_teil where id = pos.id;
    v_rest := v_rest - v_teil;
  end loop;
  return p_menge - v_rest;
end $$;

-- --- Auftragsbestätigung: Rückläufer decken MTO zuerst -----------------------------------------
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
  v_count int := 0;
  v_mo uuid;
  v_mo_count int := 0;
  v_scheduled timestamptz;
  v_genutzt jsonb := '{}'::jsonb;
  v_frei numeric;
  v_aus_lager numeric;
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
        for c in select * from bom_explode(v_kit, l.variant_id, l.qty) loop
          insert into stock_moves (
            picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
            state, reference, phantom_path)
          values (
            v_picking, c.component_variant_id, c.uom_id, round(c.qty, 4),
            v_op.default_src_id, v_op.default_dest_id, 'draft', 'Kit: ' || l.name,
            c.phantom_path);
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

    -- Route "Fertigen auf Bestellung": je Position ein Fertigungsauftrag —
    -- seit 0119 nur für das, was ein verkaufsfähig geprüfter RÜCKLÄUFER
    -- (Retoure) nicht deckt. Gewöhnlicher Fertigbestand ersetzt keine
    -- Fertigung (MTO beschafft auftragsbezogen). Gedeckelt durch den freien
    -- Bestand am Ausgangsort; mehrere Zeilen derselben Variante teilen ihn.
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      v_frei := greatest(least(
                  free_to_use(l.variant_id, v_op.default_src_id)
                    - coalesce((v_genutzt ->> l.variant_id::text)::numeric, 0),
                  ruecklaeufer_frei(l.variant_id)), 0);
      v_aus_lager := least(v_frei, l.qty);
      if v_aus_lager > 0 then
        v_genutzt := v_genutzt || jsonb_build_object(l.variant_id::text,
          coalesce((v_genutzt ->> l.variant_id::text)::numeric, 0) + v_aus_lager);
        perform ruecklaeufer_verbrauchen(l.variant_id, v_aus_lager);
        perform log_event('sales_order', p_order, 'note',
          format('%s × %s aus Rückläufer (Retoure) bedient — dafür keine Fertigung', trim_scale(v_aus_lager), l.name), p_actor);
      end if;
      if l.qty - v_aus_lager > 0 then
        v_mo := create_manufacturing_order(l.variant_id, l.qty - v_aus_lager, p_order, null, p_actor);
        update manufacturing_orders set origin = o.number where id = v_mo;
        perform mo_confirm(v_mo, p_actor);
        v_mo_count := v_mo_count + 1;
      end if;
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


-- --- Prozess „Retoure" -------------------------------------------------------------------
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('retoure', 'retouren', 'status', '/versand/retouren/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('retoure', 'Retoure',
          'Der Kunde sendet gelieferte Shop-Ware zurück: Anfrage (Portal im Shop oder intern), Genehmigung mit '
          || 'Retourenlabel, Eingang, Prüfung je Position mit Rückbuchung (verkaufsfähig ins Lager, B-Ware/Defekt '
          || 'markiert), Erstattung im Shop, Abschluss — überflüssige Fertigung entfällt.',
          'versand', 'retoure')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0119')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, ereignis, zustand, optional)
  values
    (v_version, 'start',          'Kunde will zurücksenden',          'start',    0,  null,                            null,                        null,            false),
    (v_version, 'anlegen',        'Retoure anfragen',                 'aktion',   10, 'versand.retoure_anlegen',       null,                        'angefragt',     false),
    (v_version, 'genehmigen',     'Genehmigen + Retourenlabel',       'aktion',   20, 'versand.retoure_genehmigen',    null,                        'genehmigt',     false),
    (v_version, 'ablehnen',       'Ablehnen',                         'aktion',   25, 'versand.retoure_ablehnen',      null,                        'abgelehnt',     false),
    (v_version, 'eingang',        'Ware eingegangen',                 'aktion',   30, 'versand.retoure_eingang',       null,                        'eingegangen',   false),
    (v_version, 'pruefen',        'Prüfen und zurückbuchen',          'aktion',   40, 'versand.retoure_pruefen',       null,                        'geprueft',      false),
    (v_version, 'shop_erstattet', 'Im Shop erstattet',                'ereignis', 50, null,                            'shop:bestellung_erstattet', null,            false),
    (v_version, 'abschliessen',   'Abschließen (Fertigung anpassen)', 'aktion',   60, 'versand.retoure_abschliessen',  null,                        'abgeschlossen', false),
    (v_version, 'stornieren',     'Stornieren',                       'aktion',   80, 'versand.retoure_stornieren',    null,                        'storniert',     true),
    (v_version, 'ende',           'Erledigt',                         'ende',     90, null,                            null,                        null,            false);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',          'anlegen',        10, null),
    (v_version, 'anlegen',        'genehmigen',     10, 'passt'),
    (v_version, 'anlegen',        'ablehnen',       20, 'passt nicht'),
    (v_version, 'anlegen',        'eingang',        30, 'ohne Genehmigung eingetroffen'),
    (v_version, 'anlegen',        'stornieren',     90, 'Kunde zieht zurück'),
    (v_version, 'genehmigen',     'eingang',        10, null),
    (v_version, 'genehmigen',     'stornieren',     90, 'Kunde zieht zurück'),
    (v_version, 'eingang',        'pruefen',        10, null),
    (v_version, 'pruefen',        'shop_erstattet', 10, null),
    (v_version, 'pruefen',        'abschliessen',   20, 'Erstattung von Hand bestätigt'),
    (v_version, 'shop_erstattet', 'abschliessen',   10, null),
    (v_version, 'abschliessen',   'ende',           10, null),
    (v_version, 'ablehnen',       'ende',           10, null),
    (v_version, 'stornieren',     'ende',           10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/versand/retouren', 'retoure', null)
on conflict (pfad_muster) do nothing;

-- Pakete: wer Shop-Bestellungen versendet, nimmt auch Retouren an.
update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'retoure')
 where 'shopify_bestellung_versand' = any(prozess_codes)
   and not ('retoure' = any(prozess_codes));

-- --- Einrichtungsaufgabe: Portal im Shop verlinken -----------------------------------------
insert into einrichtungsaufgaben (schluessel, titel, beschreibung, link, sortierung)
select 'retouren_portal',
       'Retourenportal im Shop verlinken',
       'Das Retourenportal läuft über die bestehende Shop-App „reparatur" unter /apps/reparatur/retoure — keine neue App nötig. Im Shop einen Menüpunkt bzw. Link „Rücksendung" darauf setzen (z. B. Weiterleitung /retoure → /apps/reparatur/retoure), den Sendcloud-Retourenportal-Link ersetzen und eine Testanfrage mit einer gelieferten Bestellung durchspielen (Anfrage → Genehmigen → Label-Mail).',
       '/versand/retouren', 60
where not exists (select 1 from einrichtungsaufgaben where schluessel = 'retouren_portal');

select einrichtungsaufgaben_anlegen('system');
