-- ===========================================================================
-- Prozess-Seeds: Modelle, Routen und die ersten zwei Prozesse
-- ===========================================================================
--
-- Gesät wird nur, was vollständig auf REGISTRIERTE Aktionen zeigt — ein
-- Prozessschritt ohne ausführbare Aktion wäre ein toter Knopf. Weitere
-- Prozesse (Artikel anlegen, Shopify-Bestellung → Versand, Fertigung,
-- Einkauf, Inventur) folgen mit den Registry-Migrationen ihrer Module.
--
-- Die Seeds sind Startbestand, keine Fessel: Änderungen laufen über
-- prozess_version_kopieren → editieren → prozess_version_aktivieren; diese
-- Datei bleibt unangetastet (Migrationen sind checksummiert).

-- --- Modell-Whitelist (Brücke zu den Statusmaschinen) -----------------------

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster) values
  ('sales_order',           'sales_orders',           'state',  '/verkauf/:id'),
  ('purchase_order',        'purchase_orders',        'state',  '/einkauf/:id'),
  ('vendor_bill',           'vendor_bills',           'state',  '/einkauf/rechnungen'),
  ('stock_picking',         'stock_pickings',         'state',  '/lager/:id'),
  ('manufacturing_order',   'manufacturing_orders',   'state',  '/fertigung/:id'),
  ('repair_order',          'repair_orders',          'state',  '/reparatur/:id'),
  ('shipment',              'shipments',              'state',  '/versand'),
  ('bug_report',            'bug_reports',            'status', '/tickets/:id'),
  ('inventory_count',       'inventory_counts',       'id',     '/lager/inventur'),
  ('stock_orderpoint',      'stock_orderpoints',      'id',     '/lager/beschaffung'),
  ('absence',               'absences',               'state',  '/personal/abwesenheiten'),
  ('prozess_instanz',       'prozess_instanzen',      'status', null);

-- Seiten ohne Beleg-ID im Pfad → Prozess (für die Ticket-Zuordnung).
insert into prozess_routen (pfad_muster, prozess_code, schritt_code) values
  ('/tickets',   'bug_ticket', null),
  ('/reparatur', 'reparatur',  null);

-- --- P1: Bug-Ticket ---------------------------------------------------------
-- Der Prozess, der den Bug-Loop trägt: melden → übernehmen → beheben/verwerfen.

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('bug_ticket', 'Fehlerticket',
          'Vom Slide-out gemeldeter Fehler bis zur belegten Behebung (Commit + Prozesstest).',
          'fehler', 'bug_report')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, rollen)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.rollen
  from v, (values
    ('start',      'Fehler beobachtet',   'start',  0,   null,                    null,        null),
    ('melden',     'Fehler melden',       'aktion', 10,  'fehler.ticket_melden',  'offen',     null),
    ('uebernehmen','In Arbeit nehmen',    'aktion', 20,  'fehler.ticket_status',  'in_arbeit', null),
    ('beheben',    'Beheben (mit Commit)','aktion', 40,  'fehler.ticket_status',  'behoben',   array['admin']),
    ('verwerfen',  'Verwerfen',           'aktion', 50,  'fehler.ticket_status',  'verworfen', null),
    ('ende',       'Erledigt',            'ende',   90,  null,                    null,        null)
  ) as t(code, name, art, seq, aktion, zustand, rollen)
  returning version_id
)
-- Beheben oder Verwerfen ist eine NUTZERWAHL, kein Daten-Gateway: zwei
-- bedingungslose Kanten aus demselben Schritt bieten beide Wege an.
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.bedingung::jsonb, t.text
from s, (values
  ('start',       'melden',      10, null, null),
  ('melden',      'uebernehmen', 10, null, null),
  ('melden',      'verwerfen',   20, null, 'kein Fehler / Duplikat'),
  ('uebernehmen', 'beheben',     10, null, 'reproduziert & behoben'),
  ('uebernehmen', 'verwerfen',   20, null, 'kein Fehler / Duplikat'),
  ('beheben',     'ende',        10, null, null),
  ('verwerfen',   'ende',        10, null, null)
) as t(von, nach, seq, bedingung, text);

-- Die Schritte „uebernehmen"/„beheben"/„verwerfen" nutzen dieselbe Aktion mit
-- vorbelegtem Status — genau wofür params da ist.
update prozess_schritte s set params = t.params::jsonb
from (values
  ('uebernehmen', '{"status": "in_arbeit"}'),
  ('beheben',     '{"status": "behoben"}'),
  ('verwerfen',   '{"status": "verworfen"}')
) as t(code, params)
where s.code = t.code
  and s.version_id = prozess_aktive_version('bug_ticket');

-- --- P2: Reparatur ----------------------------------------------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('reparatur', 'Reparatur',
          'Vom Reparaturauftrag über Teile und Abschluss bis zum Angebot an den Kunden.',
          'reparatur', 'repair_order')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',       'Gerät angenommen',      'start',  0,  null,                          null,           false),
    ('anlegen',     'Auftrag anlegen',       'aktion', 10, 'reparatur.auftrag_anlegen',   'new',          false),
    ('bestaetigen', 'Bestätigen',            'aktion', 20, 'reparatur.bestaetigen',       'confirmed',    false),
    ('beginnen',    'Reparatur beginnen',    'aktion', 30, 'reparatur.beginnen',          'under_repair', false),
    ('teile',       'Teile erfassen',        'aktion', 40, 'reparatur.teil_hinzufuegen',  null,           true),
    ('abschliessen','Abschließen',           'aktion', 50, 'reparatur.abschliessen',      'repaired',     false),
    ('kosten',      'Kostenpflichtig?',      'xor',    60, null,                          null,           false),
    ('angebot',     'Angebot erstellen',     'aktion', 70, 'reparatur.angebot_erstellen', null,           false),
    ('stornieren',  'Stornieren',            'aktion', 80, 'reparatur.stornieren',        'cancel',       true),
    ('ende',        'Erledigt',              'ende',   90, null,                          null,           false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.bedingung::jsonb, t.text
from s, (values
  ('start',        'anlegen',      10, null, null),
  ('anlegen',      'bestaetigen',  10, null, null),
  ('anlegen',      'stornieren',   90, null, 'Abbruch'),
  ('bestaetigen',  'beginnen',     10, null, null),
  ('bestaetigen',  'stornieren',   90, null, 'Abbruch'),
  ('beginnen',     'teile',        10, null, null),
  ('beginnen',     'abschliessen', 20, null, null),
  ('beginnen',     'stornieren',   90, null, 'Abbruch'),
  ('teile',        'abschliessen', 10, null, null),
  ('abschliessen', 'kosten',       10, null, null),
  ('kosten',       'angebot',      10, '{"feld": "under_warranty", "op": "!=", "wert": true}', 'kostenpflichtig'),
  ('kosten',       'ende',         20, null, 'Garantie'),
  ('angebot',      'ende',         10, null, null),
  ('stornieren',   'ende',         10, null, null)
) as t(von, nach, seq, bedingung, text);
