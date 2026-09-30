-- ============================================================================
-- 0097  Einkauf, Stufe 3 — Einkaufsprojekt: Anfragen, Angebote, Vergleich
-- ----------------------------------------------------------------------------
-- Ein Einkaufsprojekt (EP/…) bündelt einen Bedarf mit mehreren Positionen
-- (Zielpreis je Position) vom Anfragen über den Angebotsvergleich bis zur
-- Bestellung; es ist abgeschlossen, sobald alles geliefert ist. Anfragen
-- gehen je Lieferant als Mail-Entwurf in dessen Sprache hinaus und werden
-- gesammelt freigegeben. Angebote (mit Staffeln, Währung, Incoterm,
-- Werkzeug- und Musterkosten) vergleicht `einstand_schaetzen` in EUR je
-- Stück: EZB-Kurs + Umlage + Fracht (Satz je kg) + Zoll (Satz je HS-Präfix),
-- EUSt bleibt außen vor. Entscheidungslog 2026-09-30.
-- ============================================================================

insert into sequences (code, prefix, padding) values ('einkaufsprojekt', 'EP/', 5)
on conflict (code) do nothing;

create type einkaufsprojekt_status as enum
  ('bedarf', 'angefragt', 'entschieden', 'bestellt', 'abgeschlossen', 'abgebrochen');

create table einkaufsprojekte (
  id                       uuid primary key default gen_random_uuid(),
  nummer                   text not null unique,
  titel                    text not null,
  art                      text not null default 'nachproduktion'
                           check (art in ('nachproduktion', 'neuteil', 'werkzeug', 'muster', 'betriebsausstattung')),
  beschreibung             text,
  status                   einkaufsprojekt_status not null default 'bedarf',
  verantwortlich_id        uuid references users on delete set null,
  zieltermin               date,
  -- FK auf lieferantenangebote folgt unten (Tabellen verweisen gegenseitig).
  gewaehltes_angebot_id    uuid,
  entscheidung_begruendung text,
  entschieden_von          text,
  entschieden_am           timestamptz,
  bestellt_am              timestamptz,
  abgeschlossen_am         timestamptz,
  abbruch_grund            text,
  erstellt_von             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz
);
select attach_touch_trigger('einkaufsprojekte');
create index einkaufsprojekte_status_idx on einkaufsprojekte (status, created_at desc);

comment on table einkaufsprojekte is
  'Einkaufsprojekte (0097): Bedarf mit Positionen → Anfragen → Angebote → Entscheidung → Bestellung(en); abgeschlossen, sobald alles geliefert ist';

create table einkaufsprojekt_positionen (
  id              uuid primary key default gen_random_uuid(),
  projekt_id      uuid not null references einkaufsprojekte on delete cascade,
  sequence        int not null default 10,
  bezeichnung     text not null,
  -- Bestehender Artikel; neue Teile bekommen ihren Artikel beim Bestellen.
  variant_id      uuid references product_variants on delete set null,
  menge           numeric(16,4) not null check (menge > 0),
  zielpreis_eur   numeric(18,6) check (zielpreis_eur >= 0),
  gewicht_g       numeric(12,2) check (gewicht_g >= 0),
  hs_code         text,
  spezifikation   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
select attach_touch_trigger('einkaufsprojekt_positionen');
create index einkaufsprojekt_positionen_projekt_idx on einkaufsprojekt_positionen (projekt_id, sequence);

create table lieferantenanfragen (
  id            uuid primary key default gen_random_uuid(),
  projekt_id    uuid not null references einkaufsprojekte on delete cascade,
  partner_id    uuid not null references partners on delete restrict,
  status        text not null default 'entwurf' check (status in ('entwurf', 'angefragt', 'angebot', 'abgesagt')),
  entwurf_id    uuid references mail_entwuerfe on delete set null,
  thread_id     uuid references mail_threads on delete set null,
  frist         date,
  angefragt_am  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  unique (projekt_id, partner_id)
);
select attach_touch_trigger('lieferantenanfragen');
create index lieferantenanfragen_entwurf_idx on lieferantenanfragen (entwurf_id);

comment on table lieferantenanfragen is
  'Anfrage eines Einkaufsprojekts bei einem Lieferanten (0097): Mail-Entwurf in dessen Sprache → Sammelfreigabe → angefragt → Angebot';

create table lieferantenangebote (
  id                    uuid primary key default gen_random_uuid(),
  projekt_id            uuid not null references einkaufsprojekte on delete cascade,
  partner_id            uuid not null references partners on delete restrict,
  anfrage_id            uuid references lieferantenanfragen on delete set null,
  version               int not null default 1,
  waehrung              text not null default 'EUR' references currencies (code),
  incoterm_code         text references incoterms (code) on delete set null,
  incoterm_ort          text,
  zahlungsbedingung     text,
  anzahlung_pct         numeric(5,2) check (anzahlung_pct >= 0 and anzahlung_pct <= 100),
  lieferzeit_tage       int check (lieferzeit_tage >= 0),
  moq                   numeric(16,4) check (moq > 0),
  -- In Angebotswährung, einmalig; der Vergleich legt sie auf die Projektmenge um.
  werkzeugkosten        numeric(16,2) not null default 0 check (werkzeugkosten >= 0),
  musterkosten          numeric(16,2) not null default 0 check (musterkosten >= 0),
  fracht_modus          text check (fracht_modus in ('see', 'luft', 'express')),
  -- Übersteuert die Schätzung aus den Frachtsätzen (z. B. Express-Angebot).
  fracht_je_stueck_eur  numeric(18,6) check (fracht_je_stueck_eur >= 0),
  gueltig_bis           date,
  quell_dokument_id     uuid references dokumente on delete set null,
  quell_nachricht_id    uuid references mail_nachrichten on delete set null,
  notiz                 text,
  quelle                text not null default 'mensch' check (quelle in ('mensch', 'agent')),
  verworfen             boolean not null default false,
  erfasst_von           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz
);
select attach_touch_trigger('lieferantenangebote');
create index lieferantenangebote_projekt_idx on lieferantenangebote (projekt_id, partner_id, version);

comment on table lieferantenangebote is
  'Angebote zu einem Einkaufsprojekt (0097): Währung, Incoterm, Zahlung, Lieferzeit, MOQ, Werkzeug-/Musterkosten, Fracht; Preise in lieferantenangebot_staffeln';

create table lieferantenangebot_staffeln (
  id           uuid primary key default gen_random_uuid(),
  angebot_id   uuid not null references lieferantenangebote on delete cascade,
  position_id  uuid not null references einkaufsprojekt_positionen on delete cascade,
  ab_menge     numeric(16,4) not null default 1 check (ab_menge > 0),
  preis        numeric(18,6) not null check (preis >= 0),
  unique (angebot_id, position_id, ab_menge)
);

alter table einkaufsprojekte
  add constraint einkaufsprojekte_angebot_fkey
  foreign key (gewaehltes_angebot_id) references lieferantenangebote on delete set null;

-- Verknüpfungen: Bestellung ↔ Projekt, Bestellzeile/Lieferantenpreis ↔
-- Staffel, Thread/Entwurf ↔ Projekt.
alter table purchase_orders add column einkaufsprojekt_id uuid references einkaufsprojekte on delete set null;
create index purchase_orders_einkaufsprojekt_idx on purchase_orders (einkaufsprojekt_id) where einkaufsprojekt_id is not null;
alter table purchase_order_lines add column angebot_staffel_id uuid references lieferantenangebot_staffeln on delete set null;
alter table vendor_prices add column angebot_staffel_id uuid references lieferantenangebot_staffeln on delete set null;
alter table mail_threads add column einkaufsprojekt_id uuid references einkaufsprojekte on delete set null;
create index mail_threads_einkaufsprojekt_idx on mail_threads (einkaufsprojekt_id) where einkaufsprojekt_id is not null;
alter table mail_entwuerfe add column einkaufsprojekt_id uuid references einkaufsprojekte on delete set null;

-- --- Einstand: Frachtsätze und Zolltarife (Referenzdaten) --------------------

create table frachtsaetze (
  modus              text primary key check (modus in ('see', 'luft', 'express')),
  eur_je_kg          numeric(12,4) not null check (eur_je_kg > 0),
  mindestbetrag_eur  numeric(12,2) not null default 0 check (mindestbetrag_eur >= 0),
  notiz              text,
  geaendert_von      text,
  updated_at         timestamptz
);
select attach_touch_trigger('frachtsaetze');

comment on table frachtsaetze is
  'Frachtsätze für die Einstandsschätzung (0097): EUR je kg Bruttogewicht je Modus, Mindestbetrag je Sendung. Startwerte sind Schätzungen — mit K+N-Rechnungen verfeinern';

-- Startwerte sind bewusst grobe Schätzungen (Asien → DE, je kg brutto).
insert into frachtsaetze (modus, eur_je_kg, mindestbetrag_eur, notiz) values
  ('see',     1.50, 150.00, 'Startwert (Schätzung) — an K+N-Seefracht anpassen'),
  ('luft',    6.00,  90.00, 'Startwert (Schätzung) — an K+N-Luftfracht anpassen'),
  ('express', 9.00,  25.00, 'Startwert (Schätzung) — Express vom Lieferanten');

create table zolltarife (
  hs_praefix     text primary key check (hs_praefix ~ '^[0-9]{2,10}$'),
  satz_pct       numeric(5,2) not null check (satz_pct >= 0 and satz_pct <= 100),
  bezeichnung    text,
  geaendert_von  text,
  updated_at     timestamptz
);
select attach_touch_trigger('zolltarife');

comment on table zolltarife is
  'Zollsätze je HS-Präfix für die Einstandsschätzung (0097) — der längste passende Präfix gewinnt; ohne Eintrag bleibt der Zoll offen (Hinweis „kein Zollsatz")';

-- Einstand je Position eines Angebots in EUR je Stück (bei Projektmenge):
--   Ware   = Staffelpreis (größte Staffel ≤ Menge, sonst die kleinste) × Kurs
--   Umlage = Werkzeug + Muster × Kurs, nach Warenwert auf die Positionen
--   Fracht = D-Klauseln 0; sonst Übersteuerung je Stück oder
--            max(Gewicht gesamt × Satz, Mindestbetrag) nach Gewicht verteilt
--   Zoll   = (Ware + Fracht) × Satz des längsten HS-Präfixes; DDP 0
-- Kurs: letzter EUR-Kurs (exchange_rates, EUR je Fremdeinheit) — ohne Kurs
-- bleibt der Wert leer statt still 1 anzunehmen. EUSt ist nie enthalten.
create or replace function einstand_schaetzen(p_angebot uuid)
returns table (
  position_id    uuid,
  bezeichnung    text,
  menge          numeric,
  staffel_ab     numeric,
  preis          numeric,
  kurs           numeric,
  ware_eur       numeric,
  umlage_eur     numeric,
  fracht_eur     numeric,
  zoll_eur       numeric,
  einstand_eur   numeric,
  zielpreis_eur  numeric,
  hinweise       text[]
)
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  a lieferantenangebote%rowtype;
  v_kurs numeric;
  v_d_klausel boolean;
  v_ddp boolean;
  v_satz frachtsaetze%rowtype;
begin
  select * into a from lieferantenangebote where id = p_angebot;
  if a.id is null then raise exception 'Angebot nicht gefunden'; end if;

  v_kurs := case when a.waehrung = 'EUR' then 1::numeric else
    (select r.rate from exchange_rates r
     where r.currency = a.waehrung and r.valid_from <= current_date
     order by r.valid_from desc limit 1) end;
  v_d_klausel := coalesce(a.incoterm_code in ('DAP', 'DPU', 'DDP'), false);
  v_ddp := coalesce(a.incoterm_code = 'DDP', false);
  select * into v_satz from frachtsaetze f where f.modus = coalesce(a.fracht_modus, 'see');

  return query
  with pos as (
    select p.id, p.bezeichnung, p.menge, p.zielpreis_eur, p.sequence,
           coalesce(nullif(p.gewicht_g, 0), nullif(pt.weight_g, 0)::numeric) as gewicht_g,
           nullif(regexp_replace(coalesce(nullif(p.hs_code, ''), pt.hs_code, ''), '[^0-9]', '', 'g'), '') as hs,
           st.ab_menge, st.preis
    from einkaufsprojekt_positionen p
    left join product_variants pv on pv.id = p.variant_id
    left join product_templates pt on pt.id = pv.template_id
    left join lateral (
      select s.ab_menge, s.preis
      from lieferantenangebot_staffeln s
      where s.angebot_id = a.id and s.position_id = p.id
      order by (s.ab_menge <= p.menge) desc,
               case when s.ab_menge <= p.menge then -s.ab_menge else s.ab_menge end
      limit 1
    ) st on true
    where p.projekt_id = a.projekt_id
  ),
  basis as (
    select pos.*,
           pos.preis * v_kurs as ware_stk,
           pos.preis * v_kurs * pos.menge as ware_ges,
           pos.gewicht_g * pos.menge / 1000.0 as kg,
           (select z.satz_pct from zolltarife z
            where pos.hs like z.hs_praefix || '%'
            order by length(z.hs_praefix) desc limit 1) as zollsatz
    from pos
  ),
  summen as (
    select sum(b.ware_ges) as ware, sum(b.kg) as kg, bool_and(b.kg is not null) as alle_kg from basis b
  ),
  rechnung as (
    select b.*,
      case when s.ware > 0 and b.ware_stk is not null
           then (a.werkzeugkosten + a.musterkosten) * v_kurs * b.ware_stk / s.ware
           else case when a.werkzeugkosten + a.musterkosten = 0 then 0 end end as umlage_stk,
      case
        when v_d_klausel then 0
        when a.fracht_je_stueck_eur is not null then a.fracht_je_stueck_eur
        when b.kg is null or v_satz.modus is null or not s.alle_kg or s.kg = 0 then null
        else greatest(s.kg * v_satz.eur_je_kg, v_satz.mindestbetrag_eur) * (b.kg / s.kg) / b.menge
      end as fracht_stk
    from basis b, summen s
  )
  select r.id, r.bezeichnung, r.menge, r.ab_menge, r.preis, v_kurs,
         round(r.ware_stk, 4),
         round(r.umlage_stk, 4),
         round(r.fracht_stk, 4),
         round(case when v_ddp or r.hs is null or r.zollsatz is null then 0
                    else (r.ware_stk + coalesce(r.fracht_stk, 0)) * r.zollsatz / 100 end, 4),
         round(r.ware_stk + coalesce(r.umlage_stk, 0) + coalesce(r.fracht_stk, 0)
               + case when v_ddp or r.hs is null or r.zollsatz is null then 0
                      else (r.ware_stk + coalesce(r.fracht_stk, 0)) * r.zollsatz / 100 end, 4),
         r.zielpreis_eur,
         array_remove(array[
           case when r.preis is null then 'kein_preis' end,
           case when v_kurs is null then 'kein_kurs' end,
           case when r.ab_menge > r.menge then 'unter_staffel' end,
           case when a.moq is not null and r.menge < a.moq then 'unter_moq' end,
           case when not v_d_klausel and a.fracht_je_stueck_eur is null and r.kg is null then 'kein_gewicht' end,
           case when not v_d_klausel and a.fracht_je_stueck_eur is null and v_satz.modus is null then 'kein_frachtsatz' end,
           case when not v_ddp and r.hs is null then 'kein_hs' end,
           case when not v_ddp and r.hs is not null and r.zollsatz is null then 'kein_zollsatz' end,
           case when a.gueltig_bis < current_date then 'abgelaufen' end
         ], null)
  from rechnung r
  order by r.sequence, r.bezeichnung;
end $$;

comment on function einstand_schaetzen(uuid) is
  'Einstand je Position eines Lieferantenangebots in EUR je Stück bei Projektmenge (0097): Ware × EZB-Kurs + Werkzeug/Muster-Umlage + Fracht + Zoll, ohne EUSt; hinweise nennen Lücken (kein_kurs, kein_gewicht, kein_zollsatz, unter_moq …)';

-- --- Auto-Abschluss: alles geliefert → Projekt abgeschlossen -----------------

-- Ein bestelltes Projekt ist fertig, wenn es mindestens eine nicht
-- stornierte Bestellung hat und jede davon bestätigt ist und ihre Lagerware
-- vollständig eingegangen ist (reine Dienstleistung zählt ab Bestätigung).
create or replace function einkaufsprojekt_pruefen(p_projekt uuid, p_actor text default 'system')
returns boolean
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_status einkaufsprojekt_status;
  v_aktive int;
  v_offen boolean;
begin
  select status into v_status from einkaufsprojekte where id = p_projekt for update;
  if v_status is distinct from 'bestellt' then return false; end if;

  select count(*) into v_aktive
  from purchase_orders where einkaufsprojekt_id = p_projekt and state <> 'cancel';
  if v_aktive = 0 then return false; end if;

  select exists (
    select 1 from purchase_orders po
    where po.einkaufsprojekt_id = p_projekt and po.state <> 'cancel'
      and (po.state in ('draft', 'sent')
           or exists (
             select 1 from purchase_order_lines l
             join product_variants pv on pv.id = l.variant_id
             join product_templates pt on pt.id = pv.template_id
             where l.order_id = po.id and pt.type = 'goods' and l.qty_received < l.qty))
  ) into v_offen;
  if v_offen then return false; end if;

  update einkaufsprojekte set status = 'abgeschlossen', abgeschlossen_am = now() where id = p_projekt;
  perform log_event('einkaufsprojekt', p_projekt, 'state', 'Alles geliefert — Projekt abgeschlossen', p_actor);
  return true;
end $$;

create or replace function trg_einkaufsprojekt_pruefen()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  v_projekt uuid;
begin
  if tg_table_name = 'purchase_orders' then
    v_projekt := new.einkaufsprojekt_id;
  else
    select einkaufsprojekt_id into v_projekt from purchase_orders where id = new.order_id;
  end if;
  if v_projekt is not null then
    perform einkaufsprojekt_pruefen(v_projekt);
  end if;
  return null;
end $$;

create trigger purchase_order_lines_einkaufsprojekt
  after update of qty_received on purchase_order_lines
  for each row when (new.qty_received is distinct from old.qty_received)
  execute function trg_einkaufsprojekt_pruefen();

create trigger purchase_orders_einkaufsprojekt
  after update of state, einkaufsprojekt_id on purchase_orders
  for each row execute function trg_einkaufsprojekt_pruefen();

-- --- Zuordnung eingehender Mails: EP-Nummer im Betreff → Projekt -------------

-- Voller Körper aus 0093; neu: `EP/nnnnn` im Betreff ordnet den Thread dem
-- Einkaufsprojekt zu (Antworten auf Anfragen, auch in neuen Threads).
create or replace function mail_thread_zuordnen(p_thread uuid)
returns boolean language plpgsql as $$
declare
  t mail_threads%rowtype;
  v_po uuid;
  v_vendor uuid;
  v_partner uuid;
  v_projekt uuid;
  v_adresse text;
  v_domain text;
begin
  select * into t from mail_threads where id = p_thread for update;
  if t.id is null or t.zugeordnet_durch in ('mensch', 'agent') then return false; end if;

  if t.purchase_order_id is null then
    select po.id, po.vendor_id into v_po, v_vendor
    from purchase_orders po
    where po.number = substring(coalesce(t.betreff, '') from '(P[0-9]{5,})')
    limit 1;
  end if;

  if t.einkaufsprojekt_id is null then
    select ep.id into v_projekt
    from einkaufsprojekte ep
    where ep.nummer = substring(coalesce(t.betreff, '') from '(EP/[0-9]{5,})')
    limit 1;
  end if;

  if t.partner_id is null and v_vendor is null then
    select lower(n.von) into v_adresse
    from mail_nachrichten n
    where n.thread_id = p_thread and n.richtung = 'eingang' and n.von like '%@%'
    order by n.datum limit 1;
    if v_adresse is null then
      select lower(n.an[1]) into v_adresse
      from mail_nachrichten n
      where n.thread_id = p_thread and n.richtung = 'ausgang' and n.an[1] like '%@%'
      order by n.datum limit 1;
    end if;
    v_domain := split_part(v_adresse, '@', 2);
    if v_adresse is not null then
      select p.id into v_partner from partners p
      where v_adresse = any(p.mail_domains)
         or v_domain = any(p.mail_domains)
         or exists (select 1 from unnest(p.mail_domains) d
                    where position('@' in d) = 0 and v_domain like '%.' || d)
      order by (v_adresse = any(p.mail_domains)) desc, (v_domain = any(p.mail_domains)) desc
      limit 1;
    end if;
  end if;

  if v_po is null and v_vendor is null and v_partner is null and v_projekt is null then return false; end if;

  update mail_threads set
    purchase_order_id = coalesce(purchase_order_id, v_po),
    partner_id = coalesce(partner_id, v_vendor, v_partner),
    einkaufsprojekt_id = coalesce(einkaufsprojekt_id, v_projekt),
    zustaendig_id = coalesce(zustaendig_id,
      (select p.einkaeufer_id from partners p where p.id = coalesce(t.partner_id, v_vendor, v_partner)),
      (select ep.verantwortlich_id from einkaufsprojekte ep where ep.id = v_projekt)),
    zugeordnet_durch = 'regel'
  where id = p_thread;

  -- Antwort eines angefragten Lieferanten: der Thread hängt ab jetzt an der Anfrage.
  if v_projekt is not null then
    update lieferantenanfragen a set thread_id = coalesce(a.thread_id, p_thread)
    where a.projekt_id = v_projekt
      and a.partner_id = (select partner_id from mail_threads where id = p_thread);
  end if;
  return true;
end $$;

-- --- Prozess „Einkaufsprojekt" ---------------------------------------------

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('einkaufsprojekt', 'einkaufsprojekte', 'status', '/einkauf/projekte/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('einkaufsprojekt', 'Einkaufsprojekt',
          'Vom Bedarf (Positionen mit Zielpreis) über Anfragen bei mehreren Lieferanten und den '
          || 'Angebotsvergleich in EUR je Stück bis zur Bestellung — abgeschlossen, sobald alles geliefert ist.',
          'einkauf', 'einkaufsprojekt')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0097')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand)
  values
    (v_version, 'start',        'Bedarf',                         'start',  0,  null,                           null),
    (v_version, 'anlegen',      'Projekt mit Positionen anlegen', 'aktion', 10, 'einkauf.projekt_anlegen',      'bedarf'),
    (v_version, 'anfragen',     'Anfragen freigeben und senden',  'aktion', 20, 'einkauf.anfragen_freigeben',   'angefragt'),
    (v_version, 'entscheiden',  'Angebot wählen',                 'aktion', 30, 'einkauf.projekt_entscheiden',  'entschieden'),
    (v_version, 'bestellen',    'Bestellen',                      'aktion', 40, 'einkauf.projekt_bestellen',    'bestellt'),
    (v_version, 'abschliessen', 'Abschließen',                    'aktion', 50, 'einkauf.projekt_abschliessen', 'abgeschlossen'),
    (v_version, 'abbrechen',    'Abbrechen',                      'aktion', 60, 'einkauf.projekt_abbrechen',    'abgebrochen'),
    (v_version, 'ende',         'Erledigt',                       'ende',   90, null,                           null);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',        'anlegen',      10, null),
    (v_version, 'anlegen',      'anfragen',     10, 'Lieferanten anfragen'),
    (v_version, 'anlegen',      'entscheiden',  20, 'Angebot liegt schon vor'),
    (v_version, 'anlegen',      'abbrechen',    30, null),
    (v_version, 'anfragen',     'entscheiden',  10, 'Angebote da'),
    (v_version, 'anfragen',     'abbrechen',    20, null),
    (v_version, 'entscheiden',  'bestellen',    10, null),
    (v_version, 'entscheiden',  'abbrechen',    20, null),
    (v_version, 'bestellen',    'abschliessen', 10, 'alles geliefert'),
    (v_version, 'bestellen',    'abbrechen',    20, 'Bestellungen storniert'),
    (v_version, 'abschliessen', 'ende',         10, null),
    (v_version, 'abbrechen',    'ende',         10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/einkauf/projekte', 'einkaufsprojekt', null)
on conflict (pfad_muster) do nothing;

update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'einkaufsprojekt')
 where 'einkauf_wareneingang_rechnung' = any(prozess_codes)
   and not ('einkaufsprojekt' = any(prozess_codes));

-- Betriebsdaten löschen: Frachtsätze und Zolltarife sind Einrichtung.
-- Voller Körper aus 0094, Behalten-Liste um frachtsaetze/zolltarife erweitert.
create or replace function demodaten_loeschen()
returns void language plpgsql
set search_path = public, pg_temp as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
    -- Zweiter Faktor (0083): gehört zum Konto, nicht zu den Betriebsdaten.
    'backup_codes', 'vertraute_geraete',
    'uom_categories', 'uoms', 'currencies', 'exchange_rates',
    'warehouses', 'stock_locations', 'operation_types',
    'taxes', 'payment_terms', 'incoterms', 'product_categories',
    'sequences', 'tags',
    'prozesse', 'prozess_versionen', 'prozess_schritte', 'prozess_uebergaenge',
    'prozess_modelle', 'prozess_routen', 'prozess_overrides',
    'feld_definitionen', 'prozess_pakete',
    'shipping_rules',
    'nutzungs_zaehler',
    -- Finanz-Konfiguration (0058): Konten bleiben, Bewegungen fallen.
    'bankkonten',
    -- Vertriebseingang der öffentlichen Startseite (0066): kein
    -- Betriebsdatum, keine zweite Quelle.
    'registrierungen',
    -- Arbeitsplätze mit Druckern (0087): die Einrichtung der Tische bleibt.
    'work_centers', 'drucker', 'arbeitsplatz_druckwege',
    -- Mail-Vorlagen des Einkaufs (0094): Texte je Sprache sind Einrichtung.
    'mail_vorlagen',
    -- Einstand (0097): Frachtsätze und Zolltarife sind Einrichtung.
    'frachtsaetze', 'zolltarife'
  ];
  v_liste text;
  r record;
begin
  select string_agg(format('%I', tablename), ', ' order by tablename)
    into v_liste
  from pg_tables
  where schemaname = current_schema()
    and tablename <> all (v_behalten);

  if v_liste is not null then
    execute 'truncate table ' || v_liste;
  end if;

  delete from sessions where user_id in (
    select id from users
    where lower(email) in ('lager@example.com', 'fertigung@example.com'));
  delete from users
  where lower(email) in ('lager@example.com', 'fertigung@example.com');

  update sequences set next_number = 1;
  for r in select code from sequences loop
    execute format('alter sequence %I restart with 1', 'seq_' || r.code);
  end loop;

  insert into settings (key, value)
  values ('demo', jsonb_build_object('geloescht', true, 'zeitpunkt', now()))
  on conflict (key) do update set value = excluded.value;

  perform refresh_analytics('demodaten-loeschen');
end $$;
