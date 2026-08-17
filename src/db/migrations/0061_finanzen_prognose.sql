-- ===========================================================================
-- 0061  Finanzen, Ausbaustufe 4: Umsatzplan + Cashflow-Prognose
-- ===========================================================================
-- Der Umsatzplan (Monat × Szenario) speist die 13-Wochen-/12-Monats-
-- Prognose. Kern ist finanz_prognose(): alle bekannten Geldflüsse (Zahlplan-
-- Raten, offene Rechnungen, Restobligo bestätigter Bestellungen, Verträge,
-- Darlehen, Steuern) plus Quoten vom Planumsatz — mit kumulativem
-- Deckungskonto gegen die Doppelzählung von Wareneinsatz-Quote und
-- konkreten Einkaufszahlungen. finanz_unterdeckung() macht daraus den
-- Fremdkapitalbedarf fürs Cockpit.
--
-- Nichts hartkodiert: alle Quoten, Sätze, Zahltage und Versätze liegen im
-- settings-Schlüssel 'finanzen' (Merge unten — Bestehendes gewinnt).

-- --- Einstellungen ----------------------------------------------------------

insert into settings (key, value) values ('finanzen', jsonb_build_object(
  'wareneinsatz_pct',       30,   -- Warenquote vom Planumsatz (netto)
  'versand_pct',            6,    -- Versandkosten, umsatzsynchron
  'fees_pct',               3,    -- Zahlungs-/Plattformgebühren, umsatzsynchron
  'ust_satz_pct',           19,   -- Brutto-Hochrechnung der Einzahlungen
  'ust_zahltag',            10,   -- Tag der USt-Zahlung im Folgemonat
  'ust_frist_monate',       1,    -- Versatz Besteuerungsmonat -> Zahlung
  'ust_zahllast_quote_pct', 8,    -- Automatik für Planmonate ohne USt-Zeile
  'shopify_versatz_tage',   0,    -- Shopify-Auszahlung nach Bestellung
  'rechnung_versatz_tage',  14,   -- Zahlungsziel für Rechnungskunden
  'best_aufschlag_pct',     15,   -- Szenario-Band um den Basisplan
  'worst_abschlag_pct',     20,
  'liquiditaets_puffer',    0     -- Sockel, unter den der Saldo nicht soll
))
on conflict (key) do update set value = excluded.value || settings.value;

-- Ein Lesehelfer statt zwölf Subselects — Standardwert immer im Aufruf,
-- damit die Funktion auch auf einer leeren settings-Tabelle rechnet.
create or replace function finanz_einstellung(p_schluessel text, p_standard numeric)
returns numeric
language sql stable as $$
  select coalesce(
    (select (value ->> p_schluessel)::numeric from settings where key = 'finanzen'),
    p_standard);
$$;

-- --- Umsatzplan -------------------------------------------------------------

create table umsatzplan (
  monat        date not null check (monat = date_trunc('month', monat)::date),
  szenario     text not null check (szenario in ('best', 'base', 'worst')),
  umsatz_netto numeric(14,2) not null default 0 check (umsatz_netto >= 0),
  quelle       text not null default 'vorschlag' check (quelle in ('vorschlag', 'manuell')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (monat, szenario)
);
select attach_touch_trigger('umsatzplan');

comment on table umsatzplan is
  'Planumsatz (netto) je Monat und Szenario. quelle=vorschlag wird von umsatzplan_fuellen() aktualisiert, quelle=manuell (plan_setzen) gewinnt dauerhaft.';

-- Vorschlag für einen Monat: Vorjahresmonat × Trendfaktor. Der Trend misst
-- die letzten drei vollen Monate gegen dieselben drei Monate des Vorjahres
-- und ist auf 0.25–4 begrenzt — dünne Historie soll keine Fantasiezahlen
-- erzeugen. Ohne Vorjahresmonat: Durchschnitt der letzten drei Monate.
create or replace function umsatzplan_vorschlag(p_monat date)
returns numeric
language sql stable as $$
  with fenster as (
    select (date_trunc('month', current_date) - interval '3 months')::date as von,
           date_trunc('month', current_date)::date as bis   -- exklusiv
  ),
  hist as (
    select date_trunc('month', so.order_date)::date as monat, sum(t.net) as netto
    from sales_orders so
    cross join lateral sales_order_total(so.id) t
    where so.state = 'sale'
    group by 1
  ),
  aktuell as (
    select coalesce(sum(h.netto), 0) as summe, count(h.monat) as monate
    from fenster f
    left join hist h on h.monat >= f.von and h.monat < f.bis
  ),
  vorjahr_fenster as (
    select coalesce(sum(h.netto), 0) as summe
    from fenster f
    left join hist h on h.monat >= (f.von - interval '12 months')::date
                    and h.monat < (f.bis - interval '12 months')::date
  ),
  trend as (
    select case when v.summe > 0 and a.summe > 0
                then least(4, greatest(0.25, a.summe / v.summe))
                else 1 end as faktor
    from aktuell a, vorjahr_fenster v
  )
  select round(coalesce(
    (select h.netto from hist h
      where h.monat = (date_trunc('month', p_monat) - interval '12 months')::date)
      * (select faktor from trend),
    (select case when monate > 0 then summe / monate end from aktuell),
    0
  ), 2);
$$;

-- Füllt laufenden Monat + 12 Folgemonate in allen drei Szenarien. Der
-- laufende Monat gehört dazu, weil die Wochenprognose sonst bis zum
-- Monatswechsel ohne Umsatz rechnen würde. Handeingaben bleiben stehen
-- (Upsert nur über quelle='vorschlag').
create or replace function umsatzplan_fuellen(p_actor text default 'system')
returns int
language plpgsql as $$
declare
  v_best  numeric := finanz_einstellung('best_aufschlag_pct', 15);
  v_worst numeric := finanz_einstellung('worst_abschlag_pct', 20);
  v_monat date;
  v_base  numeric;
  m int;
  v_n int := 0;
begin
  for m in 0..12 loop
    v_monat := (date_trunc('month', current_date) + (m || ' months')::interval)::date;
    v_base := umsatzplan_vorschlag(v_monat);
    insert into umsatzplan (monat, szenario, umsatz_netto, quelle)
    values (v_monat, 'base',  v_base, 'vorschlag'),
           (v_monat, 'best',  round(v_base * (1 + v_best / 100), 2), 'vorschlag'),
           (v_monat, 'worst', round(greatest(0, v_base * (1 - v_worst / 100)), 2), 'vorschlag')
    on conflict (monat, szenario) do update
      set umsatz_netto = excluded.umsatz_netto
      where umsatzplan.quelle = 'vorschlag';
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Handeingabe: überschreibt den Vorschlag dauerhaft (bis zum nächsten
-- plan_setzen — umsatzplan_fuellen fasst manuelle Zeilen nie wieder an).
create or replace function plan_setzen(
  p_monat date,
  p_szenario text,
  p_betrag numeric,
  p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  v_monat date := date_trunc('month', p_monat)::date;
begin
  if p_szenario not in ('best', 'base', 'worst') then
    raise exception 'Unbekanntes Szenario: %', p_szenario;
  end if;
  if p_betrag is null or p_betrag < 0 then
    raise exception 'Der Planumsatz darf nicht negativ sein';
  end if;
  insert into umsatzplan (monat, szenario, umsatz_netto, quelle)
  values (v_monat, p_szenario, round(p_betrag, 2), 'manuell')
  on conflict (monat, szenario) do update
    set umsatz_netto = excluded.umsatz_netto, quelle = 'manuell';
end $$;

-- --- Cashflow-Prognose ------------------------------------------------------
-- Parametrisierte Funktion statt Materialized View: Szenario und Raster sind
-- Parameter, alles hängt an current_date und frischem Ist — und die Mengen
-- sind klein (13 bzw. 12 Perioden über wenige hundert Belege).
--
-- Logik je Periode:
--   Einzahlungen  Planumsatz brutto, taggenau (Monatsbetrag/Monatstage),
--                 Kanal-Split nach historischer Shopify-Quote, je Kanal mit
--                 Zahlungsversatz; plus geplante Darlehensauszahlungen und
--                 Steuer-Erstattungen.
--   Bestellungen  drei DISJUNKTE Quellen: (a) offene Zahlplan-Raten,
--                 (b) gebuchte Rechnungen mit offenem Rest (nur ohne
--                 Zahlplan an der Bestellung), (c) Restobligo bestätigter
--                 Bestellungen ohne Zahlplan und ohne (deckende) Rechnung.
--   Verträge      vertrag_zahlungen_bis (Kündigung/Ende wirkt automatisch).
--   Darlehen      offene Raten (auch geplanter Darlehen — deren Auszahlung
--                 zählt oben als Einzahlung).
--   Steuern       erfasste Termine; für Planmonate ohne USt-Zeile die
--                 Automatik ust_zahllast_quote_pct × Planumsatz, fällig im
--                 Folgemonat am Zahltag. Eine erfasste Zeile gilt exklusiv.
--   Variable      Wareneinsatz über das kumulative DECKUNGSKONTO:
--                 Soll C_t = Σ wareneinsatz_pct × Planumsatz bis t;
--                 Deckung D = Bestandswert (Warenartikel) + Zulaufwert
--                 offener bestätigter Bestellungen; Rest R_t = max(0, C_t−D);
--                 Abfluss der Periode = R_t − R_{t−1}. So zählt Ware, die
--                 schon da oder konkret bestellt ist, nicht doppelt —
--                 eine neu erfasste Bestellung wandert von der Quote in die
--                 konkreten Zahlungen, die Summe bleibt konstant.
--                 Versand + Fees laufen rein umsatzsynchron ohne Verrechnung.
-- Überfälliges (Fälligkeit vor heute) landet in Periode 1.

create or replace function finanz_prognose(
  p_szenario text default 'base',
  p_raster text default 'monat',
  p_perioden int default null
) returns table (
  periode_start date,
  periode_ende date,
  anfangssaldo numeric,
  einzahlungen numeric,
  aus_bestellungen numeric,
  aus_vertraegen numeric,
  aus_darlehen numeric,
  aus_steuern numeric,
  aus_variable_quote numeric,
  auszahlungen numeric,
  endsaldo numeric
)
language sql stable as $$
with par as (
  select case when p_szenario in ('best', 'base', 'worst') then p_szenario else 'base' end as szenario,
         case when p_raster = 'woche' then 'woche' else 'monat' end as raster,
         coalesce(p_perioden, case when p_raster = 'woche' then 13 else 12 end) as n
),
e as (
  select finanz_einstellung('wareneinsatz_pct', 30)       as wareneinsatz_pct,
         finanz_einstellung('versand_pct', 6)             as versand_pct,
         finanz_einstellung('fees_pct', 3)                as fees_pct,
         finanz_einstellung('ust_satz_pct', 19)           as ust_satz_pct,
         finanz_einstellung('ust_zahltag', 10)::int       as ust_zahltag,
         finanz_einstellung('ust_frist_monate', 1)::int   as ust_frist_monate,
         finanz_einstellung('ust_zahllast_quote_pct', 8)  as ust_quote_pct,
         finanz_einstellung('shopify_versatz_tage', 0)::int  as shopify_versatz,
         finanz_einstellung('rechnung_versatz_tage', 14)::int as rechnung_versatz
),
perioden as (
  select gs + 1 as nr,
         case when par.raster = 'woche'
              then (date_trunc('week', current_date) + gs * interval '1 week')::date
              else (date_trunc('month', current_date) + gs * interval '1 month')::date end as von,
         case when par.raster = 'woche'
              then (date_trunc('week', current_date) + (gs + 1) * interval '1 week')::date - 1
              else (date_trunc('month', current_date) + (gs + 1) * interval '1 month')::date - 1 end as bis
  from par
  cross join lateral generate_series(0, par.n - 1) gs
),
horizont as (select min(von) as von, max(bis) as bis from perioden),

-- Einzahlungen aus dem Planumsatz -------------------------------------------
kanal as (
  -- Shopify-Anteil der letzten drei vollen Monate; ohne Historie: alles
  -- Shopify (D2C-Grundannahme, Versatz 0 ist die konservativere Richtung
  -- nur scheinbar — beim Rechnungsversatz käme Geld später, dafür fehlt es
  -- am Anfang; die Quote ist schlicht die beste verfügbare Schätzung).
  select coalesce(
    sum(t.net) filter (where so.source = 'shopify') / nullif(sum(t.net), 0), 1
  ) as shopify_quote
  from sales_orders so
  cross join lateral sales_order_total(so.id) t
  where so.state = 'sale'
    and so.order_date >= date_trunc('month', current_date) - interval '3 months'
    and so.order_date <  date_trunc('month', current_date)
),
plan_tage as (
  select gs::date as tag,
         up.umsatz_netto
           / extract(day from (up.monat + interval '1 month' - interval '1 day'))::numeric as netto_tag
  from umsatzplan up
  join par on up.szenario = par.szenario
  cross join horizont h
  cross join lateral generate_series(up.monat, (up.monat + interval '1 month')::date - 1,
                                     interval '1 day') gs
  where up.umsatz_netto > 0
    and gs::date >= current_date        -- Vergangenheit ist Sache des Ist
    and gs::date <= h.bis
),
umsatz_ein as (
  select pt.tag + e.shopify_versatz as datum,
         pt.netto_tag * (1 + e.ust_satz_pct / 100) * k.shopify_quote as betrag
  from plan_tage pt, e, kanal k
  union all
  select pt.tag + e.rechnung_versatz,
         pt.netto_tag * (1 + e.ust_satz_pct / 100) * (1 - k.shopify_quote)
  from plan_tage pt, e, kanal k
),
sonst_ein as (
  select d.auszahlung_am as datum, d.betrag
  from darlehen d
  where d.status = 'geplant' and d.auszahlung_am is not null
  union all
  select s.faellig_am, abs(s.betrag)
  from steuerzahlungen s
  where s.bezahlt_am is null and s.betrag < 0
),

-- Auszahlungen: Bestellungen (drei disjunkte Quellen) ------------------------
po_aus as (
  -- (a) offene Zahlplan-Raten
  select zahlplan_faelligkeit(r) as datum, zahlplan_betrag(r) as betrag
  from zahlplan_raten r
  join purchase_orders po on po.id = r.purchase_order_id
  where r.bezahlt_am is null
    and po.state not in ('cancel', 'done')
  union all
  -- (b) gebuchte Rechnungen mit offenem Rest — nur ohne Zahlplan an der PO
  select coalesce(b.due_date, b.bill_date), vendor_bill_offen(b.id)
  from vendor_bills b
  where b.state = 'posted'
    and not b.is_credit_note
    and vendor_bill_offen(b.id) > 0
    and not exists (select 1 from zahlplan_raten r
                    where r.purchase_order_id = b.purchase_order_id)
  union all
  -- (c) Restobligo: bestellt, aber weder Zahlplan noch (deckende) Rechnung.
  -- Fällig nach Zahlungsbedingung auf die erwartete Ankunft.
  select payment_term_due_date(po.payment_term_id,
           coalesce(po.eta_confirmed, po.expected_arrival::date, current_date)),
         rest.betrag
  from purchase_orders po
  cross join lateral (
    select round(t.gross * po.exchange_rate, 2)
         - coalesce((select sum(round(bt.gross * exchange_rate_at(b.currency, b.bill_date), 2))
                     from vendor_bills b
                     cross join lateral vendor_bill_total(b.id) bt
                     where b.purchase_order_id = po.id
                       and b.state in ('posted', 'paid')
                       and not b.is_credit_note), 0) as betrag
    from purchase_order_total(po.id) t
  ) rest
  where po.state = 'purchase'
    and rest.betrag > 0
    and not exists (select 1 from zahlplan_raten r where r.purchase_order_id = po.id)
),
vertrag_aus as (
  select z.faellig_am as datum, z.betrag_eur as betrag
  from vertraege v
  cross join horizont h
  cross join lateral vertrag_zahlungen_bis(v.id, h.bis) z
  where not exists (
    select 1 from zahlungen za
    where za.vertrag_id = v.id and za.storniert_am is null
      and date_trunc('month', za.gezahlt_am) = date_trunc('month', z.faellig_am))
),
darlehen_aus as (
  select r.faellig_am as datum, r.zins + r.tilgung as betrag
  from darlehen_raten r
  join darlehen d on d.id = r.darlehen_id
  where r.bezahlt_am is null
    and d.status in ('geplant', 'laufend')
    and r.zins + r.tilgung > 0
),
steuer_aus as (
  select s.faellig_am as datum, s.betrag
  from steuerzahlungen s
  where s.bezahlt_am is null and s.betrag > 0
  union all
  select (up.monat + (e.ust_frist_monate || ' months')::interval)::date + (e.ust_zahltag - 1),
         round(up.umsatz_netto * e.ust_quote_pct / 100, 2)
  from umsatzplan up
  join par on up.szenario = par.szenario
  cross join e
  where up.umsatz_netto > 0
    and not exists (select 1 from steuerzahlungen s
                    where s.art = 'ust' and s.zeitraum_von = up.monat)
),

-- Variable Quote mit kumulativem Deckungskonto -------------------------------
deckung as (
  select coalesce((select sum(pv.valuation_total)
                   from product_variants pv
                   join product_templates pt2 on pt2.id = pv.template_id
                   where pv.active and pt2.type = 'goods'), 0)
       + coalesce((select sum(round((l.qty - l.qty_received) * l.price_unit
                                    * (1 - l.discount / 100) * po.exchange_rate, 2))
                   from purchase_order_lines l
                   join purchase_orders po on po.id = l.order_id
                   where po.state = 'purchase' and l.qty > l.qty_received), 0) as wert
),
periode_netto as (
  select p.nr, coalesce(sum(pt.netto_tag), 0) as netto
  from perioden p
  left join plan_tage pt on pt.tag between p.von and p.bis
  group by p.nr
),
quote_rest as (
  select pn.nr,
         greatest(0, sum(pn.netto) over (order by pn.nr) * e.wareneinsatz_pct / 100
                     - d.wert) as rest
  from periode_netto pn, e, deckung d
),
quote_aus as (
  select nr, rest - coalesce(lag(rest) over (order by nr), 0) as wareneinsatz
  from quote_rest
),

-- Zusammenbau ----------------------------------------------------------------
fluss as (
  select 'ein' as art, datum, betrag from umsatz_ein
  union all select 'ein',      datum, betrag from sonst_ein
  union all select 'po',       datum, betrag from po_aus
  union all select 'vertrag',  datum, betrag from vertrag_aus
  union all select 'darlehen', datum, betrag from darlehen_aus
  union all select 'steuer',   datum, betrag from steuer_aus
),
je_periode as (
  select p.nr,
         coalesce(sum(f.betrag) filter (where f.art = 'ein'), 0)      as ein,
         coalesce(sum(f.betrag) filter (where f.art = 'po'), 0)       as po,
         coalesce(sum(f.betrag) filter (where f.art = 'vertrag'), 0)  as vertrag,
         coalesce(sum(f.betrag) filter (where f.art = 'darlehen'), 0) as darlehen,
         coalesce(sum(f.betrag) filter (where f.art = 'steuer'), 0)   as steuer
  from perioden p
  left join fluss f on greatest(f.datum, current_date) between p.von and p.bis
  group by p.nr
),
start as (select coalesce((select sum(saldo) from finanz_saldo()), 0) as saldo),
verlauf as (
  select p.nr, p.von, p.bis,
         jp.ein, jp.po, jp.vertrag, jp.darlehen, jp.steuer,
         qa.wareneinsatz + pn.netto * (e.versand_pct + e.fees_pct) / 100 as variabel
  from perioden p
  join je_periode jp on jp.nr = p.nr
  join quote_aus qa on qa.nr = p.nr
  join periode_netto pn on pn.nr = p.nr
  cross join e
)
select v.von,
       v.bis,
       round(s.saldo + coalesce(sum(v.ein - v.aus_summe)
               over (order by v.nr rows between unbounded preceding and 1 preceding), 0), 2),
       round(v.ein, 2),
       round(v.po, 2),
       round(v.vertrag, 2),
       round(v.darlehen, 2),
       round(v.steuer, 2),
       round(v.variabel, 2),
       round(v.aus_summe, 2),
       round(s.saldo + sum(v.ein - v.aus_summe) over (order by v.nr), 2)
from (select verlauf.*,
             po + vertrag + darlehen + steuer + variabel as aus_summe
      from verlauf) v
cross join start s
order by v.nr;
$$;

-- Fremdkapitalbedarf: die tiefste Stelle der 12-Monats-Prognose gegen den
-- Liquiditätspuffer. Positive Zahl = so viel Fremdkapital fehlt.
create or replace function finanz_unterdeckung(p_szenario text default 'base')
returns table (min_saldo numeric, min_periode date, fremdkapitalbedarf numeric)
language sql stable as $$
  select p.endsaldo,
         p.periode_start,
         greatest(0, round(finanz_einstellung('liquiditaets_puffer', 0) - p.endsaldo, 2))
  from finanz_prognose(p_szenario, 'monat', 12) p
  order by p.endsaldo asc, p.periode_start asc
  limit 1;
$$;

-- --- Tageslauf: Umsatzplan-Vorschläge gehören jetzt dazu --------------------

create or replace function finanz_tageslauf(p_actor text default 'cron')
returns jsonb
language plpgsql as $$
declare
  v_beendet int;
  v_ust uuid;
  v_plan int;
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

  -- Vorschlags-Zeilen nachziehen (Handeingaben bleiben unberührt).
  v_plan := umsatzplan_fuellen(p_actor);

  return jsonb_build_object('vertraege_beendet', v_beendet,
                            'ust_vorschlag', v_ust is not null,
                            'umsatzplan_monate', v_plan);
end $$;
