-- ============================================================================
-- 0123 — Cashflow-Prognose: nur bestätigte Bestellungen (UX-Audit,
-- Entscheidungslog 2026-10-17)
--
-- Zahlplan-Raten zählten für jede nicht stornierte/gesperrte Bestellung —
-- also auch Anfragen und Entwürfe (Rate „bei Bestellung" heute fällig,
-- Fremdwährung mangels eingefrorenem Kurs 1:1). Gesperrte (`done`), aber
-- noch nicht bezahlte Bestellungen fielen dagegen ganz heraus. Jetzt zählen
-- Raten und Restobligo genau für bestätigte Bestellungen (purchase/done).
--
--  * finanz_prognose (voller Körper aus 0061), finanz_faellig (aus 0117):
--    nur die Zustandsfilter der Bestellquellen geändert.
-- ============================================================================

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
    and po.state in ('purchase', 'done')   -- 0123: nur bestätigte (auch gesperrte), keine Anfragen
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
  where po.state in ('purchase', 'done')   -- 0123: gesperrte Bestellungen verschwanden sonst
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
    and po.state in ('purchase', 'done')   -- 0123: nur bestätigte (auch gesperrte), keine Anfragen
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
  union all
  select 'kundenrechnung', k.id,
         k.nummer || case k.art when 'rechnung' then ' — Kundenrechnung' else ' — Gutschrift (Erstattung)' end,
         p.name,
         coalesce(k.faellig_am, k.rechnungsdatum),
         kundenrechnung_offen(k.id),
         case k.art when 'rechnung' then 'ein' else 'aus' end,
         '/verkauf/rechnungen/' || k.id
  from kundenrechnungen k
  left join partners p on p.id = k.partner_id
  where k.status = 'offen'
    and not k.probe
    and kundenrechnung_offen(k.id) > 0
    and coalesce(k.faellig_am, k.rechnungsdatum) <= p_bis
  order by faellig_am;
$$;
