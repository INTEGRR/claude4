-- ===========================================================================
-- P4: Shopify-Bestellung → Versand — der erste Prozess mit Außenwelt
-- ===========================================================================
--
-- Ereignis (Webhook), Aktionen (Verfügbarkeit, Label, Warenausgang) und
-- Dienst (Outbox-Job zur Shop-Rückmeldung) in einem Ablauf. Beleg ist die
-- LIEFERUNG (stock_picking) — sie entsteht mit der bestätigten Bestellung
-- und trägt die operative Statusmaschine (confirmed → assigned → done).
--
-- Bewusst noch ohne Matching-Schritt: die Klärliste (shopify_unmatched_lines)
-- hat ihre Auflösung heute als Admin-Maske; als Prozessschritt kommt sie,
-- sobald die Auflöse-Aktion registriert ist (Phase 6).

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('shopify_bestellung_versand', 'Shop-Bestellung → Versand',
          'Von der bezahlten Shop-Bestellung über Reservierung und Label bis zum gebuchten Warenausgang mit Shop-Rückmeldung.',
          'versand', 'stock_picking')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, job_kind, ereignis, zustand)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq,
         t.aktion, t.job_kind, t.ereignis, t.zustand
  from v, (values
    ('start',          'Bestellung im Shop',      'start',    0,  null, null, null, null),
    ('bestellung',     'Bestellung eingegangen',  'ereignis', 10, null, null, 'shop:bestellung_eingegangen', 'confirmed'),
    ('verfuegbarkeit', 'Verfügbarkeit prüfen',    'aktion',   20, 'lager.verfuegbarkeit_pruefen', null, null, 'assigned'),
    ('label',          'DHL-Label erstellen',     'aktion',   30, 'versand.label_erstellen',      null, null, null),
    ('buchen',         'Warenausgang buchen',     'aktion',   40, 'lager.transfer_buchen',        null, null, 'done'),
    ('fulfillment',    'Shop-Rückmeldung',        'dienst',   50, null, 'shopify_fulfillment_create', null, null),
    ('ende',           'Versendet',               'ende',     90, null, null, null, null)
  ) as t(code, name, art, seq, aktion, job_kind, ereignis, zustand)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',          'bestellung',     10, null),
  ('bestellung',     'verfuegbarkeit', 10, 'Bestand reservieren'),
  ('verfuegbarkeit', 'label',          10, null),
  -- Ausbuchen geht auch ohne Label (Abholung, Eigenauslieferung) — und der
  -- Standort bleibt nach dem Label-Schritt (ohne eigenen Belegzustand) auf
  -- der Reservierung stehen: von dort müssen BEIDE Wege erreichbar sein.
  ('verfuegbarkeit', 'buchen',         20, 'ohne Label / Abholung'),
  ('label',          'buchen',         10, null),
  ('buchen',         'fulfillment',    10, null),
  ('fulfillment',    'ende',           10, null)
) as t(von, nach, seq, text);

-- Ticket-Zuordnung: Meldungen von der Versandliste gehören zu diesem Prozess.
insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/versand', 'shopify_bestellung_versand', null);
