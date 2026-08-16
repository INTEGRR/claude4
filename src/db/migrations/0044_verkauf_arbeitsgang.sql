-- P: Der MANUELLE Verkaufsprozess — vom Angebot über Positionen zur
-- Bestätigung. Der Shop-Weg ist shopify_bestellung_versand; die Lieferung
-- selbst läuft dort bzw. über die Lager-Aktionen am Warenausgang.
--
-- Außerdem: die Fertigung bekommt ihre Arbeitsgang-Schritte — bewusst NICHT
-- als Seed-Änderung an 0042, sondern als NEUE VERSION über die
-- Versionsmaschine (prozess_version_kopieren → ergänzen →
-- prozess_version_aktivieren). Genau so laufen künftige Laufzeitänderungen;
-- die Migration ist nur der erste Kunde der eigenen Maschinerie.

-- --- P: Manueller Verkauf ----------------------------------------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('verkauf', 'Verkauf (manuell)',
          'Vom Angebot über Positionen bis zur Bestätigung — mit der Bestätigung entsteht die Lieferung; der Shop-Weg ist der eigene Prozess.',
          'verkauf', 'sales_order')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',       'Kundenanfrage',       'start',  0,  null,                           null,     false),
    ('anlegen',     'Angebot anlegen',     'aktion', 10, 'verkauf.auftrag_anlegen',      'draft',  false),
    -- Positionen sind wiederholbar: der Zustand bleibt draft, der Beleg
    -- steht weiter bei „anlegen" — der Schritt wird erneut angeboten.
    ('positionen',  'Positionen erfassen', 'aktion', 20, 'verkauf.position_hinzufuegen', null,     true),
    ('bestaetigen', 'Auftrag bestätigen',  'aktion', 30, 'verkauf.bestaetigen',          'sale',   false),
    ('stornieren',  'Stornieren',          'aktion', 80, 'verkauf.stornieren',           'cancel', true),
    ('ende',        'Bestätigt',           'ende',   90, null,                           null,     false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',       'anlegen',     10, null),
  ('anlegen',     'positionen',  10, null),
  ('anlegen',     'bestaetigen', 20, null),
  ('anlegen',     'stornieren',  90, 'Abbruch'),
  ('positionen',  'bestaetigen', 10, null),
  ('bestaetigen', 'ende',        10, 'Lieferung läuft'),
  ('bestaetigen', 'stornieren',  90, 'Abbruch'),
  ('stornieren',  'ende',        10, null)
) as t(von, nach, seq, text);

-- Der manuelle Verkauf gehört in die verkaufenden Geschäftsmodelle; die
-- Werkstatt bleibt bewusst schlank („Verkauf nachrangig").
update prozess_pakete
set prozess_codes = prozess_codes || '{verkauf}'
where code in ('d2c_hersteller', 'haendler')
  and not ('verkauf' = any(prozess_codes));

-- --- Fertigung: Arbeitsgänge als neue Version --------------------------------

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('fertigung', 'migration:0044');

  -- Ohne Belegzustand: die Arbeitsgänge haben ihre eigene kleine
  -- Statusmaschine (mo_operations); der Auftrag bleibt „in Arbeit".
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  values
    (v_neu, 'arbeitsgang_starten', 'Arbeitsgang starten', 'aktion', 42,
     'fertigung.arbeitsgang_starten', null, true),
    (v_neu, 'arbeitsgang_beenden', 'Arbeitsgang beenden', 'aktion', 44,
     'fertigung.arbeitsgang_beenden', null, true);

  -- „beginnen" trägt den Zustand progress und bleibt damit der Standort,
  -- solange gearbeitet wird — deshalb hängen BEIDE Arbeitsgang-Schritte
  -- direkt an ihm (nur so bietet prozess_naechste_schritte das Beenden an;
  -- mehrere Arbeitsgänge ergeben sich aus dem unveränderten Zustand von
  -- selbst, ohne Schleife im Graphen).
  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'beginnen',            'arbeitsgang_starten', 5, 'Arbeitsplan'),
    (v_neu, 'beginnen',            'arbeitsgang_beenden', 7, null),
    (v_neu, 'arbeitsgang_starten', 'arbeitsgang_beenden', 10, null),
    (v_neu, 'arbeitsgang_beenden', 'fertig_melden',       10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
