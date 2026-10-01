-- ============================================================================
-- 0107  Einkauf, Stufe 4 — Bemusterung (Golden Sample), Werkzeuge, Verträge
-- ----------------------------------------------------------------------------
-- Drei Dinge, die der Betreiber „von Anfang an" abgebildet haben wollte
-- (Interview 2026-09-29):
--
--  1. Bemusterung: Muster je Einkaufsprojekt und Lieferant in Runden
--     (Revision, Kosten, bestellt/erhalten, Tracking, Bewertung, Fotos als
--     Dokumente). Eigener Prozess `bemusterung`: anfordern → Eingang →
--     freigeben (Golden Sample) | nachbessern (nächste Runde startet von
--     selbst) | ablehnen. Das Projekt bekommt `muster_pflicht` und eine neue
--     Prozessversion mit Weiche „Musterpflicht?" und dem Teilprozess
--     Bemusterung vor dem Bestellen. HART in SQL: ein Projekt mit
--     Musterpflicht wird nicht `bestellt` ohne freigegebenes Golden Sample
--     des gewählten Lieferanten (Trigger am Statuswechsel).
--  2. Werkzeuge/Formen (WZ/…): Standort beim Lieferanten, Eigentümer,
--     Kosten, Werkzeugkosten-Zeile der Bestellung, Schuss-Lebensdauer und
--     -Zähler, Artikel/Projekt, Status. Betriebsmittel, kein Ablauf —
--     prozessfrei wie die Mail-Threads (0093).
--  3. Lieferantenverträge (NDA, QSV, Rahmenvertrag, Preisliste) mit
--     Laufzeit, Kündigungsfrist, Verlängerung und Erinnerungsvorlauf;
--     `vendor_prices.vertrag_id` — eine Preisliste erzeugt Lieferantenpreise
--     mit Gültigkeit. NICHT zu verwechseln mit `vertraege` (Fixkosten der
--     Finanzen, 0059). Ablaufende Verträge (und Werkzeuge am Ende ihrer
--     Lebensdauer) erscheinen als regelbasierte Wiedervorlage — berechnet in
--     der Sicht `einkauf_regel_wiedervorlagen`, die Tabelle `wiedervorlagen`
--     hält weiter nur manuelle.
--
-- Rein additiv. Entscheidungslog 2026-10-01, „Einkauf Stufe 4".
-- ============================================================================

-- --- 1. Bemusterung -----------------------------------------------------------

create type bemusterung_status as enum ('offen', 'freigegeben', 'abgelehnt', 'nachbessern');

create table bemusterungen (
  id              uuid primary key default gen_random_uuid(),
  projekt_id      uuid not null references einkaufsprojekte on delete cascade,
  partner_id      uuid not null references partners on delete restrict,
  angebot_id      uuid references lieferantenangebote on delete set null,
  -- Runde je Projekt und Lieferant; „nachbessern" legt die nächste an.
  runde           int not null default 1 check (runde > 0),
  revision        text,
  bezeichnung     text,
  menge           numeric(16,4) check (menge > 0),
  kosten          numeric(16,2) check (kosten >= 0),
  waehrung        text not null default 'EUR' references currencies (code),
  bestellt_am     date,
  erhalten_am     date,
  tracking        text,
  status          bemusterung_status not null default 'offen',
  -- Golden Sample = das freigegebene Referenzmuster für die Serie.
  golden          boolean not null default false,
  bewertung_note  smallint check (bewertung_note between 1 and 5),
  bewertung       text,
  bewertet_von    text,
  bewertet_am     timestamptz,
  vorgaenger_id   uuid references bemusterungen on delete set null,
  notiz           text,
  erstellt_von    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  unique (projekt_id, partner_id, runde),
  check (not golden or status = 'freigegeben')
);
select attach_touch_trigger('bemusterungen');
create index bemusterungen_partner_idx on bemusterungen (partner_id, created_at desc);
create index bemusterungen_offen_idx on bemusterungen (created_at) where status = 'offen';
-- Höchstens ein Golden Sample je Projekt und Lieferant — ein neues ersetzt das alte.
create unique index bemusterungen_golden_idx on bemusterungen (projekt_id, partner_id) where golden;

comment on table bemusterungen is
  'Muster-Runden je Einkaufsprojekt und Lieferant (0107): Revision, Kosten, bestellt/erhalten, Tracking, '
  'Bewertung; freigegeben mit golden = Golden Sample. Prozess bemusterung; Fotos als dokument_verweise';

alter table einkaufsprojekte add column muster_pflicht boolean not null default false;
comment on column einkaufsprojekte.muster_pflicht is
  'Musterpflicht (0107): bestellt wird erst mit freigegebenem Golden Sample des gewählten Lieferanten (Trigger)';

-- Liegt für das Projekt ein freigegebenes Golden Sample des Lieferanten
-- dieses Angebots vor?
create or replace function einkaufsprojekt_golden_sample(p_projekt uuid, p_angebot uuid)
returns boolean
language sql stable
set search_path = public, pg_temp as $$
  select exists (
    select 1
    from bemusterungen b
    join lieferantenangebote a on a.id = p_angebot
    where b.projekt_id = p_projekt and b.partner_id = a.partner_id
      and b.status = 'freigegeben' and b.golden)
$$;

-- Die harte Regel am Statuswechsel nach „bestellt": gleich, über welchen
-- Weg bestellt wird (Knopf, KI, API, Prozesstest) — ohne Golden Sample
-- bricht die Transaktion ab, Artikel und Bestellung entstehen nicht.
create or replace function trg_einkaufsprojekt_musterpflicht()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  v_lieferant text;
begin
  if new.muster_pflicht and not einkaufsprojekt_golden_sample(new.id, new.gewaehltes_angebot_id) then
    select pa.name into v_lieferant
    from lieferantenangebote a join partners pa on pa.id = a.partner_id
    where a.id = new.gewaehltes_angebot_id;
    raise exception '% hat Musterpflicht: ohne freigegebenes Golden Sample von % wird nicht bestellt. Erst ein Muster anfordern und als Golden Sample freigeben.',
      new.nummer, coalesce(v_lieferant, 'dem gewählten Lieferanten');
  end if;
  return new;
end $$;

create trigger einkaufsprojekte_musterpflicht
  before update of status on einkaufsprojekte
  for each row when (new.status = 'bestellt' and old.status is distinct from 'bestellt')
  execute function trg_einkaufsprojekt_musterpflicht();

-- prozess_beleg_daten: voller Körper aus 0092, neu `golden_sample` für
-- Einkaufsprojekte — die Weiche „Musterpflicht?" liest es (muster_pflicht
-- kommt als Spalte ohnehin mit).
create or replace function prozess_beleg_daten(p_modell text, p_id uuid)
returns jsonb language plpgsql stable as $$
declare
  m prozess_modelle%rowtype;
  v_daten jsonb;
  v_herkunft_tabelle text;
  v_herkunft jsonb;
  v_noetig boolean;
  v_auto boolean;
  v_lagerware boolean;
begin
  select * into m from prozess_modelle where modell = p_modell;
  if not found then
    raise exception 'Unbekanntes Prozessmodell: %', p_modell;
  end if;
  execute format('select to_jsonb(t) from %I t where id = $1', m.tabelle)
    into v_daten using p_id;
  if v_daten is null then
    raise exception 'Datensatz % in % nicht gefunden', p_id, m.tabelle;
  end if;

  -- Herkunft anreichern: nur über den Modell-Katalog aufgelöst, damit auch
  -- hier nie ein Tabellenname aus Nutzerdaten in dynamisches SQL wandert.
  if v_daten ? 'origin_model' and v_daten ? 'origin_id'
     and v_daten ->> 'origin_model' is not null
     and v_daten ->> 'origin_id' is not null then
    select mm.tabelle into v_herkunft_tabelle
    from prozess_modelle mm where mm.modell = v_daten ->> 'origin_model';
    if v_herkunft_tabelle is not null then
      execute format('select to_jsonb(t) from %I t where id = $1', v_herkunft_tabelle)
        into v_herkunft using (v_daten ->> 'origin_id')::uuid;
      if v_herkunft is not null then
        select v_daten || jsonb_object_agg('herkunft_' || key, value)
          into v_daten
        from jsonb_each(v_herkunft);
      end if;
    end if;
  end if;

  -- Abgeleitete Felder aus den Positionen: ohne sie lässt sich der Zweig
  -- „Fertigung nötig?" im Verkaufsprozess nicht als Bedingung schreiben.
  if p_modell = 'sales_order' then
    select coalesce(bool_or(pt.route_manufacture and resolve_bom(l.variant_id) is not null), false),
           coalesce(bool_or(pt.route_manufacture and pt.route_mto
                            and resolve_bom(l.variant_id) is not null), false)
      into v_noetig, v_auto
    from sales_order_lines l
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where l.order_id = p_id;

    v_daten := v_daten || jsonb_build_object(
      'fertigung_noetig', coalesce(v_noetig, false),
      'fertigung_automatisch', coalesce(v_auto, false));
  end if;

  -- Einkauf (0092): enthält die Bestellung Lagerware? Ohne Positionen gilt
  -- „ja" — der gewohnte Weg über den Wareneingang bleibt der Normalfall.
  if p_modell = 'purchase_order' then
    select coalesce(bool_or(pt.type = 'goods'), true)
      into v_lagerware
    from purchase_order_lines l
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where l.order_id = p_id;

    v_daten := v_daten || jsonb_build_object('hat_lagerware', coalesce(v_lagerware, true));
  end if;

  -- Einkauf (0107): liegt das Golden Sample des gewählten Lieferanten vor?
  if p_modell = 'einkaufsprojekt' then
    v_daten := v_daten || jsonb_build_object('golden_sample',
      coalesce(einkaufsprojekt_golden_sample(p_id, (v_daten ->> 'gewaehltes_angebot_id')::uuid), false));
  end if;

  return v_daten;
end $$;

-- Prozess „Bemusterung" (je Muster-Runde ein Beleg).
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('bemusterung', 'bemusterungen', 'status', '/einkauf/muster/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('bemusterung', 'Bemusterung',
          'Ein Muster beim Lieferanten anfordern, den Eingang erfassen und bewerten: freigeben (Golden Sample), '
          || 'nachbessern lassen (die nächste Runde startet von selbst) oder ablehnen.',
          'einkauf', 'bemusterung')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0107')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, params)
  values
    (v_version, 'start',       'Muster nötig',                    'start',  0,  null,                      null,          '{}'),
    (v_version, 'anfordern',   'Muster anfordern',                'aktion', 10, 'einkauf.muster_anfordern', 'offen',       '{}'),
    (v_version, 'eingang',     'Muster da?',                      'xor',    15, null,                      null,          '{}'),
    (v_version, 'erhalten',    'Eingang erfassen',                'aktion', 20, 'einkauf.muster_erhalten', null,          '{}'),
    (v_version, 'freigeben',   'Freigeben (Golden Sample)',       'aktion', 30, 'einkauf.muster_bewerten', 'freigegeben', '{"ergebnis": "freigeben"}'),
    (v_version, 'nachbessern', 'Nachbessern lassen (neue Runde)', 'aktion', 40, 'einkauf.muster_bewerten', 'nachbessern', '{"ergebnis": "nachbessern"}'),
    (v_version, 'ablehnen',    'Ablehnen',                        'aktion', 50, 'einkauf.muster_bewerten', 'abgelehnt',   '{"ergebnis": "ablehnen"}'),
    (v_version, 'ende',        'Bewertet',                        'ende',   90, null,                      null,          '{}');

  -- Weiche „Muster da?": vor dem Eingang wird nur erfasst (oder abgesagt),
  -- bewertet wird, was da ist. Ablehnen geht immer (Default-Kante zuletzt).
  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_version, 'start',       'anfordern',   10, null, null),
    (v_version, 'anfordern',   'eingang',     10, null, null),
    (v_version, 'eingang',     'erhalten',    10, '{"feld": "erhalten_am", "op": "leer"}'::jsonb,       'unterwegs'),
    (v_version, 'eingang',     'freigeben',   20, '{"feld": "erhalten_am", "op": "nicht_leer"}'::jsonb, 'passt'),
    (v_version, 'eingang',     'nachbessern', 30, '{"feld": "erhalten_am", "op": "nicht_leer"}'::jsonb, 'Mängel'),
    (v_version, 'eingang',     'ablehnen',    40, null,                                                 'passt nicht'),
    (v_version, 'erhalten',    'freigeben',   10, null, 'passt'),
    (v_version, 'erhalten',    'nachbessern', 20, null, 'Mängel'),
    (v_version, 'erhalten',    'ablehnen',    30, null, 'passt nicht'),
    (v_version, 'freigeben',   'ende',        10, null, null),
    (v_version, 'nachbessern', 'ende',        10, null, 'nächste Runde'),
    (v_version, 'ablehnen',    'ende',        10, null, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/einkauf/muster', 'bemusterung', null)
on conflict (pfad_muster) do nothing;

update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'bemusterung')
 where 'einkaufsprojekt' = any(prozess_codes)
   and not ('bemusterung' = any(prozess_codes));

-- Neue Version des Einkaufsprojekts: Weiche „Musterpflicht?" vor dem
-- Bestellen — mit Pflicht und ohne Golden Sample führt der Weg durch den
-- Teilprozess Bemusterung (Muster-Runden hängen über projekt_id am Projekt).
do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkaufsprojekt', 'migration:0107');

  insert into prozess_schritte (version_id, code, name, art, sequence, teilprozess, teilprozess_link, optional)
  values
    (v_neu, 'muster',      'Musterpflicht?',              'xor',     35, null,          null,                            false),
    (v_neu, 'bemusterung', 'Bemusterung (Golden Sample)', 'prozess', 37, 'bemusterung', '{"spalte": "projekt_id"}'::jsonb, false);

  delete from prozess_uebergaenge
  where version_id = v_neu and von_code = 'entscheiden' and nach_code = 'bestellen';

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_neu, 'entscheiden', 'muster',      10, null, null),
    (v_neu, 'muster',      'bestellen',   10,
     '{"eine": [{"feld": "muster_pflicht", "op": "=", "wert": false},
                {"feld": "golden_sample", "op": "=", "wert": true}]}'::jsonb,
     'ohne Musterpflicht oder Golden Sample frei'),
    (v_neu, 'muster',      'bemusterung', 20,
     '{"alle": [{"feld": "muster_pflicht", "op": "=", "wert": true},
                {"feld": "golden_sample", "op": "=", "wert": false}]}'::jsonb,
     'Golden Sample fehlt'),
    (v_neu, 'bemusterung', 'bestellen',   10, null, 'Golden Sample freigegeben'),
    (v_neu, 'bemusterung', 'abbrechen',   20, null, null);

  perform prozess_version_aktivieren(v_neu);
end $$;

-- --- 2. Werkzeuge / Formen -------------------------------------------------------

insert into sequences (code, prefix, padding) values ('werkzeug', 'WZ/', 5)
on conflict (code) do nothing;

create type werkzeug_status as enum ('in_auftrag', 'aktiv', 'gesperrt', 'ausgemustert');

create table werkzeuge (
  id                      uuid primary key default gen_random_uuid(),
  nummer                  text not null unique,
  bezeichnung             text not null,
  art                     text not null default 'form'
                          check (art in ('form', 'stanzwerkzeug', 'vorrichtung', 'sonstiges')),
  -- Standort: das Werkzeug steht beim Lieferanten, der damit fertigt.
  partner_id              uuid not null references partners on delete restrict,
  eigentuemer             text not null default 'wir' check (eigentuemer in ('wir', 'lieferant')),
  kosten                  numeric(16,2) check (kosten >= 0),
  waehrung                text not null default 'EUR' references currencies (code),
  -- Die Werkzeugkosten-Zeile der Bestellung (Stufe 3 legt sie als Dienstleistung an).
  purchase_order_line_id  uuid references purchase_order_lines on delete set null,
  einkaufsprojekt_id      uuid references einkaufsprojekte on delete set null,
  template_id             uuid references product_templates on delete set null,
  lebensdauer_schuss      int check (lebensdauer_schuss > 0),
  schuss_zaehler          int not null default 0 check (schuss_zaehler >= 0),
  status                  werkzeug_status not null default 'in_auftrag',
  status_grund            text,
  notiz                   text,
  erstellt_von            text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz
);
select attach_touch_trigger('werkzeuge');
create index werkzeuge_partner_idx on werkzeuge (partner_id);
create index werkzeuge_projekt_idx on werkzeuge (einkaufsprojekt_id) where einkaufsprojekt_id is not null;
create index werkzeuge_template_idx on werkzeuge (template_id) where template_id is not null;

comment on table werkzeuge is
  'Werkzeuge/Formen beim Lieferanten (0107, WZ/…): Eigentümer, Kosten, Werkzeugkosten-Zeile der Bestellung, '
  'Schuss-Lebensdauer und -Zähler, Artikel/Projekt, Status. Prozessfrei (Betriebsmittel, kein Ablauf)';

-- Kommentare, Dokumente und der Existenz-Check des Torwächters (kein Prozess).
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('werkzeug', 'werkzeuge', 'status', '/einkauf/werkzeuge/:id');

-- --- 3. Lieferantenverträge -----------------------------------------------------

create type lieferantenvertrag_art as enum ('nda', 'qsv', 'rahmenvertrag', 'preisliste');
create type lieferantenvertrag_status as enum ('aktiv', 'gekuendigt', 'beendet');

create table lieferantenvertraege (
  id                       uuid primary key default gen_random_uuid(),
  partner_id               uuid not null references partners on delete restrict,
  art                      lieferantenvertrag_art not null,
  titel                    text not null,
  gueltig_von              date,
  -- null = unbefristet.
  gueltig_bis              date,
  kuendigungsfrist_monate  int not null default 0 check (kuendigungsfrist_monate between 0 and 36),
  -- Verlängert sich ohne Kündigung um so viele Monate (null = endet einfach).
  verlaengerung_monate     int check (verlaengerung_monate between 1 and 120),
  -- Vorlauf der regelbasierten Wiedervorlage vor dem Kündigungsstichtag.
  erinnerung_tage          int not null default 30 check (erinnerung_tage between 0 and 365),
  -- Währung der Preisliste (Lieferantenpreise aus dem Vertrag).
  waehrung                 text not null default 'EUR' references currencies (code),
  status                   lieferantenvertrag_status not null default 'aktiv',
  gekuendigt_am            date,
  notiz                    text,
  erstellt_von             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz,
  check (gueltig_bis is null or gueltig_von is null or gueltig_bis >= gueltig_von)
);
select attach_touch_trigger('lieferantenvertraege');
create index lieferantenvertraege_partner_idx on lieferantenvertraege (partner_id);

comment on table lieferantenvertraege is
  'Verträge mit Lieferanten (0107): NDA, QSV, Rahmenvertrag, Preisliste — Laufzeit, Kündigungsfrist, '
  'Verlängerung, Erinnerung; Dokument über dokument_verweise. NICHT vertraege (Fixkosten, 0059)';

alter table vendor_prices add column vertrag_id uuid references lieferantenvertraege on delete set null;
create index vendor_prices_vertrag_idx on vendor_prices (vertrag_id) where vertrag_id is not null;

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('lieferantenvertrag', 'lieferantenvertraege', 'status', '/einkauf/vertraege/:id');

-- Aktuelles Laufzeitende: ohne Verlängerung gueltig_bis; mit Verlängerung
-- (und solange aktiv) das nächste Ende, dessen Kündigungsstichtag noch
-- nicht verstrichen ist — gerechnet ab dem ursprünglichen Ende, damit
-- Monatsenden nicht wandern.
create or replace function lieferantenvertrag_ende(v lieferantenvertraege)
returns date
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  k int := 0;
  e date := v.gueltig_bis;
begin
  if e is null or v.verlaengerung_monate is null or v.status <> 'aktiv' then
    return e;
  end if;
  while (e - make_interval(months => v.kuendigungsfrist_monate))::date < current_date and k < 1200 loop
    k := k + 1;
    e := (v.gueltig_bis + make_interval(months => v.verlaengerung_monate * k))::date;
  end loop;
  return e;
end $$;

-- Kündigungsstichtag = Laufzeitende − Kündigungsfrist (ohne Frist: das Ende).
create or replace function lieferantenvertrag_stichtag(v lieferantenvertraege)
returns date
language sql stable
set search_path = public, pg_temp as $$
  select (lieferantenvertrag_ende(v) - make_interval(months => v.kuendigungsfrist_monate))::date
$$;

-- --- 4. Regelbasierte Wiedervorlagen ------------------------------------------

-- Berechnet, nie gespeichert: erscheinen, wenn die Regel greift, und
-- verschwinden von selbst, sobald der Grund behoben ist (Vertrag verlängert,
-- gekündigt oder beendet; Werkzeug ausgemustert oder Lebensdauer erhöht).
-- faellig_am = Tag des Wiedervorlegens; frist = der eigentliche Stichtag.
create or replace view einkauf_regel_wiedervorlagen as
select 'vertrag_frist'::text                                   as regel,
       'lieferantenvertrag'::text                              as modell,
       v.id                                                    as record_id,
       v.partner_id,
       (s.stichtag - v.erinnerung_tage)                        as faellig_am,
       s.stichtag                                              as frist,
       case
         when s.ende < current_date then
           format('%s „%s" ist am %s abgelaufen — verlängern oder beenden', a.label, v.titel, to_char(s.ende, 'DD.MM.YYYY'))
         when v.verlaengerung_monate is not null then
           format('%s „%s" verlängert sich am %s um %s Monate — kündigen bis %s', a.label, v.titel,
                  to_char(s.ende, 'DD.MM.YYYY'), v.verlaengerung_monate, to_char(s.stichtag, 'DD.MM.YYYY'))
         when v.kuendigungsfrist_monate > 0 then
           format('%s „%s" läuft am %s aus — Kündigungsfrist bis %s', a.label, v.titel,
                  to_char(s.ende, 'DD.MM.YYYY'), to_char(s.stichtag, 'DD.MM.YYYY'))
         else
           format('%s „%s" läuft am %s aus', a.label, v.titel, to_char(s.ende, 'DD.MM.YYYY'))
       end                                                     as grund,
       p.einkaeufer_id                                         as zustaendig_id
from lieferantenvertraege v
join partners p on p.id = v.partner_id
cross join lateral (select lieferantenvertrag_ende(v) as ende, lieferantenvertrag_stichtag(v) as stichtag) s
cross join lateral (select case v.art when 'nda' then 'NDA' when 'qsv' then 'QSV'
                                      when 'rahmenvertrag' then 'Rahmenvertrag' else 'Preisliste' end as label) a
where v.status = 'aktiv'
  and s.ende is not null
  and s.stichtag - v.erinnerung_tage <= current_date
union all
select 'werkzeug_lebensdauer',
       'werkzeug',
       w.id,
       w.partner_id,
       current_date,
       null::date,
       format('Werkzeug %s „%s" hat %s von %s Schuss (%s %%) — Ersatz oder Überholung planen',
              w.nummer, w.bezeichnung, w.schuss_zaehler, w.lebensdauer_schuss,
              floor(100.0 * w.schuss_zaehler / w.lebensdauer_schuss)),
       p.einkaeufer_id
from werkzeuge w
join partners p on p.id = w.partner_id
where w.status = 'aktiv'
  and w.lebensdauer_schuss is not null
  and w.schuss_zaehler >= 0.9 * w.lebensdauer_schuss;

comment on view einkauf_regel_wiedervorlagen is
  'Regelbasierte Wiedervorlagen des Einkaufs (0107): ablaufende Lieferantenverträge (Stichtag − Vorlauf ≤ heute) '
  'und Werkzeuge ab 90 % ihrer Schuss-Lebensdauer. Berechnet; verschwinden von selbst, wenn der Grund behoben ist';
