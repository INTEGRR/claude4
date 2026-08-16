-- ===========================================================================
-- P5 Fertigung + P6 Einkauf (Bestellung → Wareneingang → Rechnung)
-- ===========================================================================
--
-- Drei Prozesse: der Fertigungsauftrag, die Einkaufsbestellung (bis zur
-- erzeugten Rechnung) und die Lieferantenrechnung als eigener Beleg mit
-- eigener Statusmaschine. Der Wareneingang selbst ist ein stock_picking und
-- wird — wie beim Versand — über die Lager-Aktionen gebucht; ein eigener
-- Wareneingangs-Prozess folgt bei Bedarf.
--
-- Die Inventur (P7 laut Plan) bleibt bewusst draußen: inventory_counts hat
-- keine Statusmaschine — sie wird ein beleg­loser Assistent, sobald die
-- Instanz-Ausführung beleggebundene Folge­schritte beherrscht.

-- --- P5: Fertigung ----------------------------------------------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('fertigung', 'Fertigungsauftrag',
          'Vom Entwurf über Reservierung und Start bis zur Fertigmeldung mit Backflush.',
          'fertigung', 'manufacturing_order')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',          'Bedarf erkannt',        'start',  0,  null,                               null,        false),
    ('anlegen',        'Auftrag anlegen',       'aktion', 10, 'fertigung.auftrag_anlegen',        'draft',     false),
    ('bestaetigen',    'Bestätigen',            'aktion', 20, 'fertigung.bestaetigen',            'confirmed', false),
    ('verfuegbarkeit', 'Verfügbarkeit prüfen',  'aktion', 30, 'fertigung.verfuegbarkeit_pruefen', null,        true),
    ('beginnen',       'Fertigung starten',     'aktion', 40, 'fertigung.beginnen',               'progress',  false),
    ('fertig_melden',  'Fertig melden',         'aktion', 50, 'fertigung.fertig_melden',          'done',      false),
    ('stornieren',     'Stornieren',            'aktion', 80, 'fertigung.stornieren',             'cancel',    true),
    ('ende',           'Produziert',            'ende',   90, null,                               null,        false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',          'anlegen',        10, null),
  ('anlegen',        'bestaetigen',    10, null),
  ('anlegen',        'stornieren',     90, 'Abbruch'),
  ('bestaetigen',    'verfuegbarkeit', 10, 'Komponenten reservieren'),
  ('bestaetigen',    'beginnen',       20, null),
  ('bestaetigen',    'fertig_melden',  30, 'direkt fertig melden'),
  ('bestaetigen',    'stornieren',     90, 'Abbruch'),
  ('verfuegbarkeit', 'beginnen',       10, null),
  ('beginnen',       'fertig_melden',  10, null),
  ('beginnen',       'stornieren',     90, 'Abbruch'),
  ('fertig_melden',  'ende',           10, null),
  ('stornieren',     'ende',           10, null)
) as t(von, nach, seq, text);

-- --- P6: Einkaufsbestellung -------------------------------------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('einkauf_wareneingang_rechnung', 'Einkauf → Rechnung',
          'Von der Bestellung über die Bestätigung (Wareneingang entsteht) bis zur erzeugten Lieferantenrechnung.',
          'einkauf', 'purchase_order')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',       'Bedarf erkannt',        'start',  0,  null,                          null,       false),
    ('anlegen',     'Bestellung anlegen',    'aktion', 10, 'einkauf.bestellung_anlegen',  'draft',    false),
    ('position',    'Position aufnehmen',    'aktion', 20, 'einkauf.position_hinzufuegen', null,      true),
    ('bestaetigen', 'Bestellen',             'aktion', 30, 'einkauf.bestaetigen',         'purchase', false),
    ('rechnung',    'Rechnung erstellen',    'aktion', 40, 'einkauf.rechnung_erstellen',  null,       false),
    ('stornieren',  'Stornieren',            'aktion', 80, 'einkauf.stornieren',          'cancel',   true),
    ('ende',        'Abgerechnet',           'ende',   90, null,                          null,       false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',       'anlegen',     10, null),
  ('anlegen',     'position',    10, 'Positionen erfassen'),
  ('anlegen',     'bestaetigen', 20, null),
  ('anlegen',     'stornieren',  90, 'Abbruch'),
  ('position',    'bestaetigen', 10, null),
  ('bestaetigen', 'rechnung',    10, 'nach Wareneingang'),
  ('bestaetigen', 'stornieren',  90, 'Abbruch'),
  ('rechnung',    'ende',        10, null),
  ('stornieren',  'ende',        10, null)
) as t(von, nach, seq, text);

-- --- P6b: Lieferantenrechnung -----------------------------------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('lieferantenrechnung', 'Lieferantenrechnung',
          'Vom Entwurf (Abgleich gegen Wareneingang) über die Buchung bis zur Zahlung.',
          'einkauf', 'vendor_bill')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',      'Rechnung eingegangen', 'start',  0,  null,                          null,     false),
    ('erfassen',   'Erfassen und prüfen',  'aktion', 10, 'einkauf.rechnung_details',    'draft',  false),
    ('buchen',     'Buchen',               'aktion', 20, 'einkauf.rechnung_buchen',     'posted', false),
    ('zahlen',     'Bezahlen',             'aktion', 30, 'einkauf.rechnung_zahlen',     'paid',   false),
    ('stornieren', 'Stornieren',           'aktion', 80, 'einkauf.rechnung_stornieren', 'cancel', true),
    ('ende',       'Erledigt',             'ende',   90, null,                          null,     false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',      'erfassen',   10, null),
  ('erfassen',   'buchen',     10, null),
  ('erfassen',   'stornieren', 90, 'Abbruch'),
  ('buchen',     'zahlen',     10, null),
  ('buchen',     'stornieren', 90, 'Storno mit Gegenrechnung'),
  ('zahlen',     'ende',       10, null),
  ('stornieren', 'ende',       10, null)
) as t(von, nach, seq, text);
