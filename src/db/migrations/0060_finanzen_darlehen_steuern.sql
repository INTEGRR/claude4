-- Finanzen, Teil 3: Fremdkapital und Steuern. Darlehen mit generiertem
-- Tilgungsplan (Annuität, lineare Rate, endfällig) — die Raten sind konkrete
-- künftige Auszahlungen für die Prognose; die Auszahlung selbst ist eine
-- Einzahlung. Steuerzahlungen als manuelle Termine, die USt-Zahllast wird
-- zusätzlich aus den Belegen VORGESCHLAGEN (Umsatzsteuer − Vorsteuer,
-- fällig im Folgemonat) — übersteuerbar, nie automatisch gebucht.

insert into sequences (code, prefix, padding) values ('darlehen', 'DA/', 5)
on conflict (code) do nothing;

create table darlehen (
  id                  uuid primary key default gen_random_uuid(),
  nummer              text not null unique,
  name                text not null,
  partner_id          uuid references partners on delete set null,
  betrag              numeric(16,2) not null check (betrag > 0),
  zinssatz_pct        numeric(6,3) not null default 0 check (zinssatz_pct >= 0),
  art                 text not null default 'annuitaet'
                      check (art in ('annuitaet', 'rate', 'endfaellig')),
  auszahlung_am       date not null,
  laufzeit_monate     int not null check (laufzeit_monate > 0),
  tilgungsfrei_monate int not null default 0 check (tilgungsfrei_monate >= 0),
  zahltag             int not null default 1 check (zahltag between 1 and 28),
  bankkonto_id        uuid references bankkonten on delete set null,
  status              text not null default 'geplant'
                      check (status in ('geplant', 'laufend', 'getilgt')),
  notiz               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
select attach_touch_trigger('darlehen');
comment on table darlehen is
  'Fremdkapital mit generiertem Tilgungsplan — Annuität, lineare Rate oder endfällig. Auszahlung und Raten laufen über das Zahlungsregister.';

create table darlehen_raten (
  id          uuid primary key default gen_random_uuid(),
  darlehen_id uuid not null references darlehen on delete cascade,
  nr          int not null,
  faellig_am  date not null,
  zins        numeric(16,2) not null,
  tilgung     numeric(16,2) not null,
  restschuld  numeric(16,2) not null,
  bezahlt_am  date,
  unique (darlehen_id, nr)
);
comment on table darlehen_raten is
  'Generierter Tilgungsplan (darlehen_raten_generieren) — Zins + Tilgung je Termin, Restschuld nach der Rate.';

alter table zahlungen add column darlehen_id uuid references darlehen on delete set null;
alter table zahlungen add column darlehen_rate_id uuid references darlehen_raten on delete set null;
alter table zahlungen drop constraint zahlungen_quelle_check;
alter table zahlungen add constraint zahlungen_quelle_check
  check (quelle in ('vendor_bill', 'po_rate', 'vertrag', 'darlehen', 'darlehen_rate', 'steuer', 'manuell'));

create table steuerzahlungen (
  id           uuid primary key default gen_random_uuid(),
  art          text not null check (art in ('ust', 'gewst', 'kst', 'sonstige')),
  zeitraum_von date not null,
  zeitraum_bis date not null,
  bezeichnung  text not null,
  -- > 0 = Zahllast (Auszahlung), < 0 = Erstattung (Einzahlung).
  betrag       numeric(16,2) not null,
  faellig_am   date not null,
  quelle       text not null default 'manuell' check (quelle in ('manuell', 'vorschlag')),
  bezahlt_am   date,
  notiz        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  unique (art, zeitraum_von, zeitraum_bis),
  check (zeitraum_bis >= zeitraum_von)
);
select attach_touch_trigger('steuerzahlungen');
comment on table steuerzahlungen is
  'Steuertermine (USt/GewSt/KSt/sonstige) — manuell erfasst oder als USt-Vorschlag aus den Belegen übernommen; bezahlt über das Register.';

alter table zahlungen add column steuerzahlung_id uuid references steuerzahlungen on delete set null;

-- --- Tilgungsplan-Generator -------------------------------------------------

-- Annuität: A = S·i/(1−(1+i)^−n) mit i = Monatszins; Rate: lineare Tilgung
-- plus Zins auf die Restschuld; endfällig: nur Zinsen, Schlussrate tilgt.
-- Regeneriert wird nur, solange keine Rate bezahlt ist — bezahlte Pläne
-- sind Historie.
create or replace function darlehen_raten_generieren(p_darlehen uuid, p_actor text default 'system')
returns int
language plpgsql as $$
declare
  d darlehen;
  i numeric;              -- Monatszins
  n int;                  -- Tilgungsraten (nach tilgungsfreier Zeit)
  annuitaet numeric;
  rest numeric;
  zins numeric;
  tilgung numeric;
  nr int := 0;
  faellig date;
begin
  select * into d from darlehen where id = p_darlehen;
  if d.id is null then raise exception 'Unbekanntes Darlehen'; end if;
  if exists (select 1 from darlehen_raten where darlehen_id = p_darlehen and bezahlt_am is not null) then
    raise exception 'Der Tilgungsplan hat bereits bezahlte Raten und wird nicht neu erzeugt';
  end if;
  delete from darlehen_raten where darlehen_id = p_darlehen;

  i := d.zinssatz_pct / 100.0 / 12.0;
  n := d.laufzeit_monate - d.tilgungsfrei_monate;
  if n <= 0 then raise exception 'Die tilgungsfreie Zeit frisst die ganze Laufzeit'; end if;
  rest := d.betrag;

  if d.art = 'annuitaet' and i > 0 then
    annuitaet := round(d.betrag * i / (1 - power(1 + i, -n)), 2);
  elsif d.art = 'annuitaet' then
    annuitaet := round(d.betrag / n, 2);
  end if;

  for m in 1..d.laufzeit_monate loop
    nr := nr + 1;
    faellig := (date_trunc('month', d.auszahlung_am + make_interval(months => m))
                + make_interval(days => d.zahltag - 1))::date;
    zins := round(rest * i, 2);
    if m <= d.tilgungsfrei_monate then
      tilgung := 0;
    elsif d.art = 'endfaellig' then
      tilgung := case when m = d.laufzeit_monate then rest else 0 end;
    elsif d.art = 'rate' then
      tilgung := case when m = d.laufzeit_monate then rest else round(d.betrag / n, 2) end;
    else -- annuitaet
      tilgung := case when m = d.laufzeit_monate then rest
                      else least(rest, round(annuitaet - zins, 2)) end;
    end if;
    rest := round(rest - tilgung, 2);
    insert into darlehen_raten (darlehen_id, nr, faellig_am, zins, tilgung, restschuld)
    values (p_darlehen, nr, faellig, zins, tilgung, rest);
  end loop;

  perform log_event('darlehen', p_darlehen, 'note',
    format('Tilgungsplan erzeugt (%s Raten, %s)', nr, d.art), p_actor);
  return nr;
end $$;

create or replace function darlehen_auszahlen(
  p_darlehen uuid,
  p_datum date default current_date,
  p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  d darlehen;
  z uuid;
begin
  select * into d from darlehen where id = p_darlehen;
  if d.id is null then raise exception 'Unbekanntes Darlehen'; end if;
  if d.status <> 'geplant' then
    raise exception 'Das Darlehen % ist bereits ausgezahlt', d.nummer;
  end if;
  if not exists (select 1 from darlehen_raten where darlehen_id = p_darlehen) then
    perform darlehen_raten_generieren(p_darlehen, p_actor);
  end if;
  z := zahlung_erfassen('ein', d.betrag, 'EUR', p_datum, d.bankkonto_id,
                        'manuell', null, format('Darlehensauszahlung %s', d.nummer), p_actor);
  update zahlungen set quelle = 'darlehen', darlehen_id = p_darlehen, partner_id = d.partner_id
  where id = z;
  update darlehen set status = 'laufend' where id = p_darlehen;
  perform log_event('darlehen', p_darlehen, 'state', 'Ausgezahlt', p_actor);
end $$;

create or replace function darlehen_rate_zahlen(
  p_rate uuid,
  p_datum date default current_date,
  p_bankkonto uuid default null,
  p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  r darlehen_raten;
  d darlehen;
  z uuid;
begin
  select * into r from darlehen_raten where id = p_rate;
  if r.id is null then raise exception 'Unbekannte Darlehensrate'; end if;
  if r.bezahlt_am is not null then raise exception 'Die Rate ist bereits bezahlt'; end if;
  select * into d from darlehen where id = r.darlehen_id;
  if r.zins + r.tilgung > 0 then
    z := zahlung_erfassen('aus', r.zins + r.tilgung, 'EUR', p_datum,
                          coalesce(p_bankkonto, d.bankkonto_id), 'manuell', null,
                          format('%s — Rate %s (Zins %s, Tilgung %s)', d.nummer, r.nr, r.zins, r.tilgung),
                          p_actor);
    update zahlungen set quelle = 'darlehen_rate', darlehen_rate_id = p_rate,
                         darlehen_id = d.id, partner_id = d.partner_id
    where id = z;
  end if;
  update darlehen_raten set bezahlt_am = p_datum where id = p_rate;
  if not exists (select 1 from darlehen_raten
                 where darlehen_id = d.id and bezahlt_am is null) then
    update darlehen set status = 'getilgt' where id = d.id;
    perform log_event('darlehen', d.id, 'state', 'Vollständig getilgt', p_actor);
  end if;
end $$;

-- --- USt-Vorschlag ----------------------------------------------------------

-- Umsatzsteuer aus bestätigten Verkäufen des Monats, Vorsteuer aus gebuchten
-- Lieferantenrechnungen (Gutschriften negativ). Fälligkeit administrativ:
-- ust_frist_monate nach Monatsende am ust_zahltag.
create or replace function ust_zahllast_vorschlag(p_monat date)
returns table (umsatzsteuer numeric, vorsteuer numeric, zahllast numeric, faellig_am date)
language sql stable as $$
  with grenzen as (
    select date_trunc('month', p_monat)::date as von,
           (date_trunc('month', p_monat) + interval '1 month' - interval '1 day')::date as bis
  ), ust as (
    select coalesce(sum(t.tax), 0) as wert
    from sales_orders so
    cross join lateral sales_order_total(so.id) t, grenzen g
    where so.state = 'sale' and so.order_date between g.von and g.bis
  ), vst as (
    select coalesce(sum(case when b.is_credit_note then -t.tax else t.tax end), 0) as wert
    from vendor_bills b
    cross join lateral vendor_bill_total(b.id) t, grenzen g
    where b.state in ('posted', 'paid')
      and b.bill_date between g.von and g.bis
  )
  select round(ust.wert, 2), round(vst.wert, 2), round(ust.wert - vst.wert, 2),
         (date_trunc('month', p_monat)
          + make_interval(months => coalesce(
              (select (value->>'ust_frist_monate')::int from settings where key = 'finanzen'), 1))
          + make_interval(days => coalesce(
              (select (value->>'ust_zahltag')::int from settings where key = 'finanzen'), 10) - 1))::date
  from ust, vst;
$$;

create or replace function ust_vorschlag_uebernehmen(p_monat date, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  v record;
  v_id uuid;
  v_von date := date_trunc('month', p_monat)::date;
  v_bis date := (date_trunc('month', p_monat) + interval '1 month' - interval '1 day')::date;
begin
  select * into v from ust_zahllast_vorschlag(p_monat);
  insert into steuerzahlungen (art, zeitraum_von, zeitraum_bis, bezeichnung, betrag, faellig_am, quelle)
  values ('ust', v_von, v_bis,
          format('USt-Voranmeldung %s', to_char(v_von, 'MM/YYYY')),
          v.zahllast, v.faellig_am, 'vorschlag')
  on conflict (art, zeitraum_von, zeitraum_bis) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'Für den Zeitraum % existiert bereits ein USt-Termin', to_char(v_von, 'MM/YYYY');
  end if;
  return v_id;
end $$;

create or replace function steuer_zahlen(
  p_steuer uuid,
  p_datum date default current_date,
  p_bankkonto uuid default null,
  p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  s steuerzahlungen;
  z uuid;
begin
  select * into s from steuerzahlungen where id = p_steuer;
  if s.id is null then raise exception 'Unbekannter Steuertermin'; end if;
  if s.bezahlt_am is not null then raise exception 'Der Steuertermin ist bereits beglichen'; end if;
  if s.betrag <> 0 then
    z := zahlung_erfassen(case when s.betrag > 0 then 'aus' else 'ein' end,
                          abs(s.betrag), 'EUR', p_datum, p_bankkonto, 'manuell', null,
                          s.bezeichnung, p_actor);
    update zahlungen set quelle = 'steuer', steuerzahlung_id = p_steuer where id = z;
  end if;
  update steuerzahlungen set bezahlt_am = p_datum where id = p_steuer;
end $$;

-- --- Fällig-Liste: Darlehensraten und Steuertermine dazu --------------------

create or replace function finanz_faellig(p_bis date default current_date + 14)
returns table (quelle text, ref uuid, label text, partner text,
               faellig_am date, betrag_eur numeric, richtung text, link text)
language sql stable as $$
  select 'po_rate' as quelle, r.id as ref,
         po.number || ' — ' || r.bezeichnung as label,
         p.name as partner,
         zahlplan_faelligkeit(r) as faellig_am,
         zahlplan_betrag(r) as betrag_eur,
         'aus' as richtung,
         '/einkauf/' || po.id as link
  from zahlplan_raten r
  join purchase_orders po on po.id = r.purchase_order_id
  left join partners p on p.id = po.vendor_id
  where r.bezahlt_am is null
    and po.state not in ('cancel', 'done')
    and zahlplan_faelligkeit(r) <= p_bis
  union all
  select 'vendor_bill', b.id,
         b.number || ' — Lieferantenrechnung',
         p.name,
         coalesce(b.due_date, b.bill_date),
         vendor_bill_offen(b.id),
         'aus',
         '/einkauf/rechnungen/' || b.id
  from vendor_bills b
  left join partners p on p.id = b.vendor_id
  where b.state = 'posted'
    and not b.is_credit_note
    and vendor_bill_offen(b.id) > 0
    and coalesce(b.due_date, b.bill_date) <= p_bis
    and not exists (select 1 from zahlplan_raten r where r.purchase_order_id = b.purchase_order_id)
  union all
  select 'vertrag', v.id,
         v.nummer || ' — ' || v.name,
         p.name,
         z.faellig_am,
         z.betrag_eur,
         'aus',
         '/finanzen/vertraege/' || v.id
  from vertraege v
  left join partners p on p.id = v.partner_id
  cross join lateral vertrag_zahlungen_bis(v.id, p_bis) z
  where not exists (
    select 1 from zahlungen za
    where za.vertrag_id = v.id and za.storniert_am is null
      and date_trunc('month', za.gezahlt_am) = date_trunc('month', z.faellig_am))
  union all
  select 'darlehen_rate', r.id,
         d.nummer || ' — Rate ' || r.nr || ' (' || d.name || ')',
         p.name,
         r.faellig_am,
         r.zins + r.tilgung,
         'aus',
         '/finanzen/darlehen/' || d.id
  from darlehen_raten r
  join darlehen d on d.id = r.darlehen_id
  left join partners p on p.id = d.partner_id
  where r.bezahlt_am is null
    and d.status = 'laufend'
    and r.zins + r.tilgung > 0
    and r.faellig_am <= p_bis
  union all
  select 'steuer', s.id,
         s.bezeichnung,
         null,
         s.faellig_am,
         abs(s.betrag),
         case when s.betrag > 0 then 'aus' else 'ein' end,
         '/finanzen/steuern'
  from steuerzahlungen s
  where s.bezahlt_am is null
    and s.betrag <> 0
    and s.faellig_am <= p_bis
  order by faellig_am;
$$;

-- --- Tageslauf (Cron ?task=finanzen) ---------------------------------------
-- Idempotent über Schlüssel und Status: gekündigte/befristete Verträge auf
-- 'beendet', sobald das effektive Ende erreicht ist; USt-Vorschlag für den
-- abgelaufenen Monat anlegen, falls noch keiner existiert.

create or replace function finanz_tageslauf(p_actor text default 'cron')
returns jsonb
language plpgsql as $$
declare
  v_beendet int;
  v_ust uuid;
  v_monat date := (date_trunc('month', current_date) - interval '1 month')::date;
begin
  update vertraege v set status = 'beendet'
  where v.status in ('aktiv', 'gekuendigt')
    and vertrag_ende_effektiv(v) is not null
    and vertrag_ende_effektiv(v) < current_date;
  get diagnostics v_beendet = row_count;

  if not exists (
    select 1 from steuerzahlungen
    where art = 'ust' and zeitraum_von = v_monat
  ) then
    begin
      v_ust := ust_vorschlag_uebernehmen(v_monat, p_actor);
    exception when others then
      v_ust := null;  -- Vorschlag ist Komfort, kein Muss
    end;
  end if;

  return jsonb_build_object('vertraege_beendet', v_beendet,
                            'ust_vorschlag', v_ust is not null);
end $$;
