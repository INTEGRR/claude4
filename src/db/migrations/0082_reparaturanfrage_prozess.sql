-- ===========================================================================
-- 0082  Reparatur end-to-end: Funktionen, Reparaturanfrage-Prozess, Reparatur v2
-- ===========================================================================
-- Struktur kam in 0081 (neue Enum-Werte dürfen erst in einer Folge-
-- transaktion verwendet werden). Hier die Logik und die Daten:
--
--   1. Statusfunktionen: repair_confirm akzeptiert 'received' und WIRFT bei
--      falschem Status (statt still zurückzukehren), repair_cancel verbietet
--      'shipped', repair_add_part erlaubt die neuen Wartezustände; neu sind
--      repair_await_device (Retourenlabel raus), repair_receive (Gerät im
--      Haus, ohne Bestandsbuchung) und repair_ship (Rückgabe an den Kunden).
--   2. mv_rma_analysis zählt 'shipped' als repariert — sonst leerte der neue
--      Endzustand die Kennzahl.
--   3. Prozess reparatur_anfrage v1 — ein Laufzeit-Prozess auf Vorgängen mit
--      dem Reparaturauftrag als Teilprozess (Verkettung über origin_*).
--   4. Felder der Reparaturanfrage (feld_definitionen am Prozess, nur im
--      Anlage-Schritt sichtbar; der FK braucht den Prozess zuerst).
--   5. Prozess reparatur v2 — Retourenlabel → Geräteeingang vor dem
--      Bestätigen, Rückversand nach Angebot/Garantie.
--   6. werkszustand_herstellen verschont die Felder ausgelieferter Prozesse.
--
-- Entscheidungslog 2026-09-19.

-- --- 1. Statusfunktionen ----------------------------------------------------

create or replace function repair_confirm(p_repair uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  r repair_orders%rowtype;
  part record;
  v_stock uuid;
  v_production uuid;
  v_scrap uuid;
  v_src uuid;
  v_dest uuid;
  v_move uuid;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  -- Werfen statt still zurückkehren (0010): ein Klick im falschen Status
  -- bekommt jetzt eine Antwort, wie bei repair_end.
  if r.state not in ('new', 'received') then
    raise exception 'Reparaturauftrag % kann nicht bestätigt werden (Status %)', r.number, r.state;
  end if;

  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;
  select id into v_scrap from stock_locations where is_scrap limit 1;

  for part in select * from repair_parts where repair_id = p_repair and move_id is null loop
    if part.part_type = 'add' then
      v_src := v_stock; v_dest := v_production;
    elsif part.part_type = 'remove' then
      v_src := v_production; v_dest := v_scrap;
    else
      v_src := v_production; v_dest := v_stock;
    end if;

    insert into stock_moves (repair_id, variant_id, uom_id, qty,
                             src_location_id, dest_location_id, state, reference)
    values (p_repair, part.variant_id, part.uom_id, part.qty, v_src, v_dest,
            'confirmed', 'Reparatur ' || r.number)
    returning id into v_move;

    update repair_parts set move_id = v_move where id = part.id;

    if part.part_type = 'add' then
      perform move_reserve(v_move);
    end if;
  end loop;

  update repair_orders set state = 'confirmed' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state', 'Reparatur bestätigt', p_actor);
end $$;

create or replace function repair_cancel(p_repair uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare part record;
begin
  if exists (select 1 from repair_orders where id = p_repair and state in ('repaired', 'shipped')) then
    raise exception 'Abgeschlossene oder versendete Reparaturen können nicht storniert werden';
  end if;
  for part in select move_id from repair_parts where repair_id = p_repair and move_id is not null loop
    perform move_cancel(part.move_id);
  end loop;
  update repair_orders set state = 'cancel' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state', 'Reparatur storniert', p_actor);
end $$;

create or replace function repair_add_part(
  p_repair uuid,
  p_variant uuid,
  p_qty numeric,
  p_part_type repair_part_type,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  r repair_orders%rowtype;
  v_uom uuid;
  v_price numeric;
  v_part uuid;
  v_move uuid;
  v_stock uuid;
  v_production uuid;
  v_scrap uuid;
  v_src uuid;
  v_dest uuid;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state not in ('new', 'awaiting_device', 'received', 'confirmed', 'under_repair') then
    raise exception 'Im Status % lassen sich keine Teile mehr erfassen', r.state;
  end if;
  if p_qty <= 0 then raise exception 'Die Menge muss größer als 0 sein'; end if;

  select pt.uom_id, pt.list_price into v_uom, v_price
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
  if v_uom is null then raise exception 'Teil nicht gefunden'; end if;

  insert into repair_parts (repair_id, sequence, part_type, variant_id, qty, uom_id, price_unit)
  values (p_repair,
          coalesce((select max(sequence) + 10 from repair_parts where repair_id = p_repair), 10),
          p_part_type, p_variant, p_qty, v_uom, coalesce(v_price, 0))
  returning id into v_part;

  -- Vor dem Bestätigen reicht die Zeile — repair_confirm zieht die Bewegungen.
  if r.state in ('new', 'awaiting_device', 'received') then return v_part; end if;

  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;
  select id into v_scrap from stock_locations where is_scrap limit 1;

  if p_part_type = 'add' then
    v_src := v_stock; v_dest := v_production;
  elsif p_part_type = 'remove' then
    v_src := v_production; v_dest := v_scrap;
  else
    v_src := v_production; v_dest := v_stock;
  end if;

  insert into stock_moves (repair_id, variant_id, uom_id, qty,
                           src_location_id, dest_location_id, state, reference)
  values (p_repair, p_variant, v_uom, p_qty, v_src, v_dest,
          'confirmed', 'Reparatur ' || r.number)
  returning id into v_move;

  update repair_parts set move_id = v_move where id = v_part;

  if p_part_type = 'add' then
    perform move_reserve(v_move);
  end if;

  perform log_event('repair_order', p_repair, 'note',
    'Teil während der Reparatur erfasst (' || p_part_type || ', Menge ' || p_qty || ')',
    p_actor);
  return v_part;
end $$;

/*
 * Retourenlabel ist raus: der Auftrag wartet auf das Gerät. Aus
 * 'awaiting_device' ein No-op (Label erneut gesendet).
 */
create or replace function repair_await_device(p_repair uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare r repair_orders%rowtype;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state = 'awaiting_device' then return; end if;
  if r.state <> 'new' then
    raise exception 'Reparaturauftrag % wartet nicht mehr auf das Gerät (Status %)', r.number, r.state;
  end if;
  update repair_orders set state = 'awaiting_device' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state',
    'Retourenlabel gesendet — wartet auf das Gerät', p_actor);
end $$;

/*
 * Das Kundengerät ist im Haus (Scan am Wareneingang). Keine Bestandsbuchung:
 * das Gerät gehört dem Kunden. Auch aus 'new' erlaubt (Walk-in, oder der
 * optionale Label-Schritt ist abgeschaltet).
 */
create or replace function repair_receive(
  p_repair uuid, p_actor text default 'system', p_vermerk text default null
) returns void
language plpgsql as $$
declare r repair_orders%rowtype;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state not in ('new', 'awaiting_device') then
    raise exception 'Reparaturauftrag %: Geräteeingang im Status % nicht möglich', r.number, r.state;
  end if;
  update repair_orders set state = 'received', received_at = now() where id = p_repair;
  perform log_event('repair_order', p_repair, 'state',
    'Gerät eingegangen' || coalesce(' — ' || nullif(p_vermerk, ''), ''), p_actor);
end $$;

/*
 * Rückgabe an den Kunden: per DHL (Sendung hängt über shipments.repair_order_id)
 * oder ohne Label (Abholung, Eigenversand). Endzustand 'shipped'.
 */
create or replace function repair_ship(
  p_repair uuid, p_actor text default 'system', p_vermerk text default null
) returns void
language plpgsql as $$
declare r repair_orders%rowtype;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state <> 'repaired' then
    raise exception 'Reparaturauftrag % ist nicht repariert (Status %) — Rückgabe nicht möglich', r.number, r.state;
  end if;
  update repair_orders set state = 'shipped' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state',
    'An den Kunden zurückgegeben' || coalesce(' — ' || nullif(p_vermerk, ''), ''), p_actor);
end $$;

-- --- 2. Kennzahl: versendet zählt als repariert -----------------------------
-- DESTRUKTIV: mv_rma_analysis ist eine berechnete Sicht — refresh_analytics()
-- baut sie jederzeit aus repair_orders neu; sie wird hier mit erweitertem
-- Filter sofort wieder angelegt. Kein Datenverlust.
drop materialized view mv_rma_analysis;
create materialized view mv_rma_analysis as
with rma as (
  select date_trunc('month', r.created_at)::date as monat,
         r.variant_id,
         count(*)::int as rma_count,
         count(*) filter (where r.state in ('repaired', 'shipped'))::int as repaired,
         count(*) filter (where r.state = 'cancel')::int as cancelled,
         coalesce(sum((select sum(rp.qty) from repair_parts rp
                       where rp.repair_id = r.id and rp.part_type = 'add')), 0) as parts_used
  from repair_orders r
  where r.variant_id is not null
  group by 1, 2
),
geliefert as (
  select monat, variant_id, sum(qty) as qty_delivered
  from mv_contribution_margin
  group by 1, 2
)
select coalesce(rma.monat, g.monat) as monat,
       coalesce(rma.variant_id, g.variant_id) as variant_id,
       coalesce(rma.rma_count, 0) as rma_count,
       coalesce(rma.repaired, 0) as repaired,
       coalesce(rma.cancelled, 0) as cancelled,
       coalesce(rma.parts_used, 0) as parts_used,
       coalesce(g.qty_delivered, 0) as qty_delivered,
       case when coalesce(g.qty_delivered, 0) > 0
            then round(coalesce(rma.rma_count, 0)::numeric / g.qty_delivered * 100, 2) end as rma_rate
from rma
full outer join geliefert g on g.monat = rma.monat and g.variant_id = rma.variant_id
where coalesce(rma.rma_count, 0) > 0 or coalesce(g.qty_delivered, 0) > 0;

create unique index mv_rma_analysis_idx on mv_rma_analysis (monat, variant_id);

comment on materialized view mv_rma_analysis is
  'Reparaturaufträge je Monat und Variante gegen die ausgelieferte Menge (repariert = repaired + shipped).';

-- --- 3. Prozess „Reparaturanfrage" (Laufzeit-Prozess auf Vorgängen) ---------
-- Keine Fachtabelle, kein Enum: Zustände definiert der Prozess. Der
-- Reparaturauftrag hängt als Teilprozess daran (origin_* aus 0081); der
-- Vorgang bleibt „angenommen", der Fortschritt kommt aus dem Kindbeleg
-- (Muster 0072, Schritt 'abwicklung'). Die Version entsteht als Entwurf
-- und wird über prozess_version_aktivieren scharf — so prüft der Deploy die
-- Verkettbarkeit selbst.
do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('reparatur_anfrage', 'Reparaturanfrage',
          'Eine Reparaturanfrage des Kunden (Formular oder Telefon) prüfen und annehmen — daraus entstehen Kunde, Reparaturauftrag mit RMA-Nummer und Retourenlabel — oder ablehnen.',
          'reparatur', 'vorgang')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0082')
  returning id into v_version;

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, teilprozess, teilprozess_link, zustand, params, optional)
  values
    (v_version, 'start',      'Anfrage eingegangen',          'start',  0,  null,                         null,        null, null,          '{}',                                    false),
    (v_version, 'anlegen',    'Anfrage erfassen',             'aktion', 10, 'vorgang.anlegen',            null,        null, 'neu',         '{"prozess_code": "reparatur_anfrage"}', false),
    (v_version, 'rueckfrage', 'Rückfrage beim Kunden',        'aktion', 20, 'vorgang.status_setzen',      null,        null, 'rueckfrage',  '{"state": "rueckfrage"}',               true),
    (v_version, 'annehmen',   'Annehmen → Reparaturauftrag',  'aktion', 30, 'reparatur.anfrage_annehmen', null,        null, 'angenommen',  '{"state": "angenommen"}',               false),
    (v_version, 'ablehnen',   'Ablehnen',                     'aktion', 40, 'vorgang.status_setzen',      null,        null, 'abgelehnt',   '{"state": "abgelehnt"}',                false),
    (v_version, 'reparatur',  'Reparatur & Rückversand',      'prozess', 50, null,                        'reparatur', null, null,          '{}',                                    false),
    (v_version, 'ende',       'Erledigt',                     'ende',   90, null,                         null,        null, null,          '{}',                                    false);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',      'anlegen',    10, null),
    (v_version, 'anlegen',    'annehmen',   10, 'annehmen'),
    (v_version, 'anlegen',    'ablehnen',   20, 'passt nicht'),
    (v_version, 'anlegen',    'rueckfrage', 30, 'Rückfrage'),
    (v_version, 'rueckfrage', 'annehmen',   10, 'annehmen'),
    (v_version, 'rueckfrage', 'ablehnen',   20, 'passt nicht'),
    (v_version, 'annehmen',   'reparatur',  10, null),
    (v_version, 'reparatur',  'ende',       10, null),
    (v_version, 'ablehnen',   'ende',       10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/vorgaenge/prozess/reparatur_anfrage', 'reparatur_anfrage', null)
on conflict (pfad_muster) do nothing;

-- Pakete: Anfrage gehört zu jedem Paket, das repariert.
update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'reparatur_anfrage')
 where code in ('d2c_hersteller', 'werkstatt')
   and not ('reparatur_anfrage' = any(prozess_codes));

-- --- 4. Felder der Reparaturanfrage -----------------------------------------
-- Nur im Anlage-Schritt sichtbar (schritte = {anlegen}) — sonst erschienen
-- alle zehn Felder auch in der Maske „Annehmen". Dieselbe Namensliste lebt
-- als ANFRAGE_FELDER in src/modules/shared/reparaturanfrage.ts; ein Test
-- gleicht beide ab.
insert into feld_definitionen
  (modell, prozess_code, name, label, typ, pflicht, schritte, sichtbar_in, sequence)
values
  ('vorgang', 'reparatur_anfrage', 'kontakt_name',       'Name',                     'text', true,  '{anlegen}', '{formular,liste}', 10),
  ('vorgang', 'reparatur_anfrage', 'email',              'E-Mail',                   'text', true,  '{anlegen}', '{formular,liste}', 20),
  ('vorgang', 'reparatur_anfrage', 'telefon',            'Telefon',                  'text', false, '{anlegen}', '{formular}',       30),
  ('vorgang', 'reparatur_anfrage', 'strasse',            'Straße',                   'text', true,  '{anlegen}', '{formular}',       40),
  ('vorgang', 'reparatur_anfrage', 'hausnummer',         'Hausnummer',               'text', true,  '{anlegen}', '{formular}',       50),
  ('vorgang', 'reparatur_anfrage', 'plz',                'PLZ',                      'text', true,  '{anlegen}', '{formular}',       60),
  ('vorgang', 'reparatur_anfrage', 'ort',                'Ort',                      'text', true,  '{anlegen}', '{formular,liste}', 70),
  ('vorgang', 'reparatur_anfrage', 'land',               'Land (ISO-2)',             'text', true,  '{anlegen}', '{formular}',       80),
  ('vorgang', 'reparatur_anfrage', 'fehlerbeschreibung', 'Fehlerbeschreibung',       'text', true,  '{anlegen}', '{formular}',       90),
  ('vorgang', 'reparatur_anfrage', 'bestellnummer',      'Bestellnummer (optional)', 'text', false, '{anlegen}', '{formular,liste}', 100)
on conflict (modell, (coalesce(prozess_code, '')), name) do nothing;

-- --- 5. Reparatur v2: Gerät per Post hin und zurück -------------------------
do $$
declare v_neu uuid;
begin
  v_neu := prozess_version_kopieren('reparatur', 'migration:0082');

  -- Das Gerät kommt jetzt auch per Post — der Start ist nicht mehr „Gerät angenommen".
  update prozess_schritte set name = 'Reparatur nötig'
   where version_id = v_neu and code = 'start';
  update prozess_uebergaenge set beschriftung = 'Gerät liegt vor'
   where version_id = v_neu and von_code = 'anlegen' and nach_code = 'bestaetigen';

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  values
    (v_neu, 'retourenlabel', 'Retourenlabel senden',   'aktion', 12, 'reparatur.retourenlabel_senden', 'awaiting_device', true),
    (v_neu, 'eingang',       'Gerät eingegangen',      'aktion', 14, 'reparatur.geraet_eingegangen',   'received',        false),
    (v_neu, 'rueckversand',  'Rückgabe an den Kunden', 'aktion', 75, 'reparatur.rueckversand_label',   'shipped',         false);

  -- DESTRUKTIV: betrifft nur die soeben KOPIERTE, noch inaktive Version —
  -- die Kanten kosten→ende („Garantie") und angebot→ende weichen dem
  -- Rückversand-Schritt; Version 1 bleibt archiviert und vollständig.
  delete from prozess_uebergaenge
   where version_id = v_neu and nach_code = 'ende' and von_code in ('kosten', 'angebot');

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_neu, 'anlegen',       'retourenlabel', 5,  null, 'Gerät kommt per Post'),
    (v_neu, 'retourenlabel', 'eingang',       10, null, null),
    (v_neu, 'retourenlabel', 'stornieren',    90, null, 'Abbruch'),
    (v_neu, 'eingang',       'bestaetigen',   10, null, null),
    (v_neu, 'eingang',       'stornieren',    90, null, 'Abbruch'),
    (v_neu, 'kosten',        'rueckversand',  20, null, 'Garantie / ohne Angebot'),
    (v_neu, 'angebot',       'rueckversand',  10, null, null),
    (v_neu, 'rueckversand',  'ende',          10, null, null);

  perform prozess_version_aktivieren(v_neu);
end $$;

-- --- 6. Werkszustand: Felder ausgelieferter Prozesse bleiben ----------------
-- 0069 löschte ALLE feld_definitionen — die Felder der Reparaturanfrage
-- wären nach einem Reset weg, obwohl der Prozess (Auslieferungsstand)
-- bleibt. Felder eines Prozesses mit ausgelieferter Version sind selbst
-- Auslieferungsstand.
create or replace function werkszustand_herstellen(p_admin uuid, p_actor text default 'system')
returns void language plpgsql as $$
declare
  v_rolle text;
  v_geloescht int;
begin
  select role into v_rolle from users where id = p_admin;
  if v_rolle is null then
    raise exception 'Unbekanntes Konto — der Werkszustand braucht das Konto, das ihn auslöst';
  end if;
  if v_rolle <> 'admin' then
    raise exception 'Nur Administratoren können den Werkszustand herstellen';
  end if;

  perform demodaten_loeschen();

  delete from prozess_versionen
  where coalesce(created_by, '') not like 'migration:%'
    and coalesce(created_by, '') <> 'system';
  delete from prozesse p
  where not exists (select 1 from prozess_versionen v where v.prozess_id = p.id);

  delete from prozess_overrides;
  delete from feld_definitionen f
   where f.prozess_code is null
      or not exists (
        select 1 from prozess_versionen v
        join prozesse p on p.id = v.prozess_id
        where p.code = f.prozess_code
          and (coalesce(v.created_by, '') like 'migration:%' or v.created_by = 'system'));

  update prozesse set aktiv = true;

  delete from sessions where user_id <> p_admin;
  get diagnostics v_geloescht = row_count;
  delete from users where id <> p_admin;

  update settings
     set value = '{"name":"Meine Firma GmbH","street":"Musterstraße","house":"1",
                   "zip":"10115","city":"Berlin","country":"DEU",
                   "email":"info@example.com","phone":""}'::jsonb
   where key = 'company';

  delete from settings where key in ('einrichtung', 'demo');

  perform log_event('system', gen_random_uuid(), 'state',
    'Werkszustand hergestellt — Betriebsdaten, eigene Prozessversionen, ' ||
    'Firmendaten und Konten zurückgesetzt', p_actor);
end $$;
