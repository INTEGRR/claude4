-- Finanzen, Teil 2: Fixkosten als Verträge. Miete, Lizenzen (Sendcloud,
-- Replo …), Gehälter, Aushilfen, Versicherungen — alles, was regelmäßig
-- abfließt, wird ein Vertrag mit Intervall, Zahltag und Kündigungsmechanik.
-- Die Verträge speisen später die Cashflow-Projektion (vertrag_zahlungen_bis)
-- und heute schon die Fällig-Liste und das Kündigungs-Signal: wer die Frist
-- eines Verlängerungsvertrags verpasst, hängt eine weitere Laufzeit drin.

insert into sequences (code, prefix, padding) values ('vertrag', 'VT/', 5)
on conflict (code) do nothing;

create table vertraege (
  id                      uuid primary key default gen_random_uuid(),
  nummer                  text not null unique,
  name                    text not null,
  -- Werteliste aus settings finanzen.vertrag_kategorien — bewusst text,
  -- die Kategorien sind Firmensache, kein Schema.
  kategorie               text not null default 'sonstiges',
  partner_id              uuid references partners on delete set null,
  -- BRUTTO je Intervall — die Zahlungssicht; Netto/Steuer trennt später die
  -- USt-Schätzung (Phase 3), nicht der Vertrag.
  betrag                  numeric(16,2) not null check (betrag > 0),
  waehrung                text not null default 'EUR' references currencies (code),
  intervall               text not null default 'monatlich'
                          check (intervall in ('monatlich', 'quartalsweise', 'jaehrlich')),
  zahltag                 int not null default 1 check (zahltag between 1 and 28),
  beginn                  date not null,
  ende                    date,          -- befristet; null = unbefristet
  -- Mindestlaufzeit = rollierende Verlängerungsperiode (z. B. 12 Monate).
  laufzeit_monate         int check (laufzeit_monate > 0),
  kuendigungsfrist_monate int not null default 0 check (kuendigungsfrist_monate >= 0),
  gekuendigt_am           date,
  gekuendigt_zum          date,
  status                  text not null default 'aktiv'
                          check (status in ('aktiv', 'gekuendigt', 'beendet')),
  notiz                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz
);
select attach_touch_trigger('vertraege');
create index vertraege_status_idx on vertraege (status);
comment on table vertraege is
  'Fixkosten-Verträge (Miete, Lizenzen, Personal-Posten …): Intervall, Zahltag, Laufzeit- und Kündigungsmechanik. Speist Fällig-Liste, Kündigungs-Signal und die Cashflow-Projektion.';

alter table zahlungen add column vertrag_id uuid references vertraege on delete set null;
alter table zahlungen drop constraint zahlungen_quelle_check;
alter table zahlungen add constraint zahlungen_quelle_check
  check (quelle in ('vendor_bill', 'po_rate', 'vertrag', 'manuell'));
create index zahlungen_vertrag_idx on zahlungen (vertrag_id) where vertrag_id is not null;

-- --- Kündigungs-Mathematik --------------------------------------------------

create or replace function vertrag_ende_effektiv(v vertraege)
returns date
language sql immutable as $$
  select least(coalesce(v.gekuendigt_zum, v.ende), coalesce(v.ende, v.gekuendigt_zum));
$$;

-- Nächster Termin, ZU dem gekündigt werden kann: bei Mindestlaufzeit das
-- rollierende Laufzeitende (beginn + n × laufzeit), dessen Frist noch nicht
-- verstrichen ist; ohne Laufzeit das Monatsende nach Ablauf der Frist.
create or replace function vertrag_naechstes_kuendbar_zum(v vertraege)
returns date
language plpgsql stable as $$
declare
  kandidat date;
begin
  if v.status <> 'aktiv' then return null; end if;
  if v.laufzeit_monate is not null then
    kandidat := (v.beginn + make_interval(months => v.laufzeit_monate))::date - 1;
    while (kandidat - make_interval(months => v.kuendigungsfrist_monate))::date < current_date loop
      kandidat := (kandidat + make_interval(months => v.laufzeit_monate))::date;
    end loop;
    return kandidat;
  end if;
  -- Unbefristet ohne Mindestlaufzeit: zum Monatsende nach der Frist.
  return (date_trunc('month', current_date + make_interval(months => v.kuendigungsfrist_monate))
          + interval '1 month' - interval '1 day')::date;
end $$;

/** Letzter Tag, an dem die Kündigung für den nächsten Termin raus muss. */
create or replace function vertrag_kuendigungsfrist_bis(v vertraege)
returns date
language sql stable as $$
  select (vertrag_naechstes_kuendbar_zum(v)
          - make_interval(months => v.kuendigungsfrist_monate))::date;
$$;

-- Signal-Prädikat (Muster einkauf_freigabe_noetig): nur Verträge mit
-- Mindestlaufzeit — dort kostet die verpasste Frist eine ganze Periode.
-- Vorlauf administrativ (settings finanzen.kuendigungs_vorlauf_tage).
create or replace function vertrag_kuendigung_ansteht(p_vertrag uuid)
returns boolean
language sql stable as $$
  select v.status = 'aktiv'
     and v.laufzeit_monate is not null
     and vertrag_kuendigungsfrist_bis(v)
         between current_date
             and current_date + coalesce(
               (select (value->>'kuendigungs_vorlauf_tage')::int from settings where key = 'finanzen'), 60)
  from vertraege v where v.id = p_vertrag;
$$;

create or replace function vertrag_kuendigen(
  p_vertrag uuid,
  p_zum date default null,
  p_actor text default 'system'
) returns date
language plpgsql as $$
declare
  v vertraege;
  v_zum date;
  v_fruehestens date;
begin
  select * into v from vertraege where id = p_vertrag;
  if v.id is null then raise exception 'Unbekannter Vertrag'; end if;
  if v.status <> 'aktiv' then
    raise exception 'Der Vertrag % ist nicht aktiv (Status: %)', v.nummer, v.status;
  end if;
  v_fruehestens := vertrag_naechstes_kuendbar_zum(v);
  v_zum := coalesce(p_zum, v_fruehestens);
  if v_zum < v_fruehestens then
    raise exception 'Frühester Kündigungstermin unter Wahrung der Frist ist der %', v_fruehestens;
  end if;
  update vertraege
  set gekuendigt_am = current_date, gekuendigt_zum = v_zum, status = 'gekuendigt'
  where id = p_vertrag;
  perform log_event('vertrag', p_vertrag, 'state',
    format('Gekündigt zum %s', v_zum), p_actor);
  return v_zum;
end $$;

-- --- Zahlungsprojektion -----------------------------------------------------

-- Künftige Zahlungstermine bis zum Horizont: Monatsraster ab Vertragsbeginn
-- im Intervallschritt, Tag = Zahltag, gedeckelt auf das effektive Ende.
-- Vergangene Termine sind Sache des Ist-Registers, nicht der Projektion.
create or replace function vertrag_zahlungen_bis(p_vertrag uuid, p_bis date)
returns table (faellig_am date, betrag_eur numeric)
language sql stable as $$
  select gs::date + (v.zahltag - 1),
         round(v.betrag * exchange_rate_at(v.waehrung), 2)
  from vertraege v
  cross join lateral generate_series(
    date_trunc('month', v.beginn),
    p_bis,
    (case v.intervall when 'monatlich' then 1 when 'quartalsweise' then 3 else 12 end
          || ' months')::interval
  ) gs
  where v.id = p_vertrag
    and v.status <> 'beendet'
    and gs::date + (v.zahltag - 1) >= greatest(v.beginn, current_date)
    and gs::date + (v.zahltag - 1) <= least(coalesce(vertrag_ende_effektiv(v), p_bis), p_bis);
$$;

-- Zahlung auf einen Vertrag erfassen (erweitert die Register-Funktion aus
-- 0058 um die Quelle 'vertrag' — ein Termin gilt als beglichen, wenn im
-- selben Monat eine nicht stornierte Vertragszahlung existiert).
create or replace function zahlung_erfassen(
  p_richtung text,
  p_betrag numeric,
  p_waehrung text default 'EUR',
  p_datum date default current_date,
  p_bankkonto uuid default null,
  p_quelle text default 'manuell',
  p_ref uuid default null,
  p_zweck text default null,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_kurs numeric;
  v_partner uuid;
  v_bill vendor_bills;
  v_rate zahlplan_raten;
  v_vertrag vertraege;
  v_offen numeric;
begin
  if p_betrag is null or p_betrag <= 0 then
    raise exception 'Der Zahlungsbetrag muss größer als null sein';
  end if;
  if p_richtung not in ('ein', 'aus') then
    raise exception 'Unbekannte Zahlungsrichtung: %', p_richtung;
  end if;

  v_kurs := exchange_rate_at(p_waehrung, p_datum);

  if p_quelle = 'vendor_bill' then
    select * into v_bill from vendor_bills where id = p_ref;
    if v_bill.id is null then raise exception 'Unbekannte Rechnung'; end if;
    if v_bill.state not in ('posted', 'paid') then
      raise exception 'Zahlungen sind erst auf gebuchte Rechnungen möglich (Status: %)', v_bill.state;
    end if;
    v_offen := vendor_bill_offen(p_ref);
    if v_offen <= 0 then
      raise exception 'Die Rechnung % ist bereits vollständig gedeckt', v_bill.number;
    end if;
    v_partner := v_bill.vendor_id;
  elsif p_quelle = 'po_rate' then
    select * into v_rate from zahlplan_raten where id = p_ref;
    if v_rate.id is null then raise exception 'Unbekannte Zahlplan-Rate'; end if;
    if v_rate.bezahlt_am is not null then
      raise exception 'Die Rate „%" ist bereits bezahlt', v_rate.bezeichnung;
    end if;
    select vendor_id into v_partner from purchase_orders where id = v_rate.purchase_order_id;
  elsif p_quelle = 'vertrag' then
    select * into v_vertrag from vertraege where id = p_ref;
    if v_vertrag.id is null then raise exception 'Unbekannter Vertrag'; end if;
    v_partner := v_vertrag.partner_id;
  elsif p_quelle <> 'manuell' then
    raise exception 'Unbekannte Zahlungsquelle: %', p_quelle;
  end if;

  insert into zahlungen (nummer, richtung, betrag, waehrung, kurs, betrag_eur,
                         gezahlt_am, bankkonto_id, quelle,
                         vendor_bill_id, zahlplan_rate_id, vertrag_id,
                         partner_id, verwendungszweck)
  values (next_sequence('zahlung'), p_richtung, p_betrag, p_waehrung, v_kurs,
          round(p_betrag * v_kurs, 2), p_datum, p_bankkonto, p_quelle,
          case when p_quelle = 'vendor_bill' then p_ref end,
          case when p_quelle = 'po_rate' then p_ref end,
          case when p_quelle = 'vertrag' then p_ref end,
          v_partner, p_zweck)
  returning id into v_id;

  if p_quelle = 'vendor_bill' then
    if vendor_bill_offen(p_ref) <= 0 and v_bill.state = 'posted' then
      update vendor_bills set state = 'paid', paid_at = p_datum::timestamptz where id = p_ref;
    end if;
    perform log_event('vendor_bill', p_ref, 'state',
      format('Zahlung %s € erfasst, offen: %s €', round(p_betrag * v_kurs, 2), vendor_bill_offen(p_ref)),
      p_actor);
  elsif p_quelle = 'po_rate' then
    update zahlplan_raten set bezahlt_am = p_datum where id = p_ref;
    perform log_event('purchase_order', v_rate.purchase_order_id, 'state',
      format('Zahlplan-Rate „%s" bezahlt (%s €)', v_rate.bezeichnung, round(p_betrag * v_kurs, 2)),
      p_actor);
  elsif p_quelle = 'vertrag' then
    perform log_event('vertrag', p_ref, 'state',
      format('Vertragszahlung %s € erfasst', round(p_betrag * v_kurs, 2)), p_actor);
  end if;

  return v_id;
end $$;

-- --- Fällig-Liste um Vertragsraten erweitern --------------------------------
-- Ein Termin zählt als offen, solange im Fälligkeitsmonat keine (nicht
-- stornierte) Vertragszahlung erfasst ist.

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
  order by faellig_am;
$$;

-- --- Prozess: Fixkosten-Vertrag ---------------------------------------------

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('vertrag', 'vertraege', 'status', '/finanzen/vertraege/:id');

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/finanzen/vertraege', 'vertrag_fixkosten', null);

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('vertrag_fixkosten', 'Fixkosten-Vertrag',
          'Vom Vertragsabschluss (Miete, Lizenz, Personal-Posten) über die laufende Zahlung bis zur fristgerechten Kündigung.',
          'finanzen', 'vertrag')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand
  from v, (values
    ('start',     'Vertrag geschlossen',      'start',  0,  null,                        null),
    ('anlegen',   'Vertrag anlegen',          'aktion', 10, 'finanzen.vertrag_anlegen',  'aktiv'),
    ('kuendigen', 'Fristgerecht kündigen',    'aktion', 30, 'finanzen.vertrag_kuendigen','gekuendigt'),
    ('ende',      'Beendet',                  'ende',   90, null,                        null)
  ) as t(code, name, art, seq, aktion, zustand)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',     'anlegen',   10, null),
  ('anlegen',   'kuendigen', 10, 'Frist im Blick (Signal)'),
  ('kuendigen', 'ende',      10, null)
) as t(von, nach, seq, text);

-- Verträge gehören in jedes Geschäftsmodell — alle Pakete nehmen den
-- Prozess auf; damit erscheint der Finanzbereich in der Chamäleon-Navigation.
update prozess_pakete
set prozess_codes = prozess_codes || array['vertrag_fixkosten']
where not ('vertrag_fixkosten' = any (prozess_codes));

-- Phase-2-Schlüssel der Finanz-Einstellungen (Merge, Bestehendes gewinnt).
insert into settings (key, value)
values ('finanzen', jsonb_build_object(
  'kuendigungs_vorlauf_tage', 60,
  'vertrag_kategorien', jsonb_build_array('miete', 'lizenzen', 'personal', 'versicherung', 'beratung', 'sonstiges')
))
on conflict (key) do update set value = excluded.value || settings.value;
