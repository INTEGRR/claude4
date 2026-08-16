-- P: Inventur-Assistent — der erste beleglose Prozess mit beleggebundenem
-- FOLGESCHRITT: „Zählung erfassen" erzeugt den Beleg (inventory_count),
-- „Differenz buchen" arbeitet auf genau diesem Beleg weiter. Den Bezug hält
-- die Instanz (daten->>'beleg_id'); /api/aktion und der Prozesstest lösen
-- ihn für beleggebundene Aktionen ohne explizite record_id auf.
--
-- Den Inventar-Abgleich mit dem Shop stößt der Quants-Trigger nach der
-- Buchung von selbst an (Outbox) — er ist Infrastruktur, kein Schritt.

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('inventur', 'Inventur',
          'Bestand zählen und die Differenz buchen — der Assistent führt von der Zählung zur gebuchten Korrektur.',
          'lager', null)
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.optional
  from v, (values
    ('start',   'Inventur nötig',    'start',  0,  null,                     false),
    ('zaehlen', 'Zählung erfassen',  'aktion', 10, 'lager.zaehlung_erfassen', false),
    ('buchen',  'Differenz buchen',  'aktion', 20, 'lager.zaehlung_buchen',   false),
    ('ende',    'Bestand korrigiert', 'ende',  90, null,                     false)
  ) as t(code, name, art, seq, aktion, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',   'zaehlen', 10, null),
  ('zaehlen', 'buchen',  10, null),
  ('buchen',  'ende',    10, null)
) as t(von, nach, seq, text);

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/p/inventur', 'inventur', null),
       ('/lager/inventur', 'inventur', null);

-- Bestand zählt jedes Geschäftsmodell mit Lager.
update prozess_pakete
set prozess_codes = prozess_codes || '{inventur}'
where not ('inventur' = any(prozess_codes));
