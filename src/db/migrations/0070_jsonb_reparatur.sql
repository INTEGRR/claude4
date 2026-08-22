-- ===========================================================================
-- 0070  Reparatur: jsonb-Felder, die als STRING gespeichert wurden
-- ===========================================================================
-- Befund aus dem Pilotbetrieb: Jeder von der KI entworfene Prozess hatte
-- seine jsonb-Felder doppelt verpackt — gespeichert war ein JSON-STRING
-- ("{\"prozess_code\":\"x\"}") statt eines Objekts ({"prozess_code": "x"}).
--
-- Ursache war die Schreibweise `${JSON.stringify(wert)}::jsonb` in
-- einstellungen.prozess_entwerfen: der Treiber verpackt einen bereits
-- serialisierten String noch einmal. Behoben im Code (t.json(…)), aber die
-- bereits geschriebenen Zeilen bleiben kaputt — und zwar unsichtbar:
--
--   * `params` als String ließ die Vorgangsmaske auf einen TypeError laufen
--     ("Cannot use 'in' operator") — die Detailseite eines Vorgangs war
--     schlicht nicht erreichbar.
--   * `bedingung` als String bekam bedingung_pruefen nie als Bedingung zu
--     fassen — die XOR-Zweige aller KI-entworfenen Prozesse griffen nicht.
--
-- Diese Migration räumt den Bestand auf. `#>> '{}'` holt den Text aus dem
-- jsonb-Skalar, der Cast macht daraus wieder das gemeinte Objekt. Idempotent:
-- sie fasst nur an, was wirklich ein String ist.
--
-- Kein DESTRUKTIV-Marker: es wird nichts gelöscht, nur eine Fehlkodierung
-- zurückgedreht.

update prozess_schritte
   set params = (params #>> '{}')::jsonb
 where jsonb_typeof(params) = 'string';

update prozess_schritte
   set teilprozess_link = (teilprozess_link #>> '{}')::jsonb
 where jsonb_typeof(teilprozess_link) = 'string';

update prozess_uebergaenge
   set bedingung = (bedingung #>> '{}')::jsonb
 where jsonb_typeof(bedingung) = 'string';

-- Damit dieselbe Fehlkodierung nicht unbemerkt zurückkommt: die Felder sind
-- ab jetzt als Objekt (bzw. leer) festgeschrieben. Ein String scheitert
-- sofort beim Schreiben statt erst beim Benutzen.
alter table prozess_schritte
  add constraint prozess_schritte_params_objekt
  check (jsonb_typeof(params) = 'object'),
  add constraint prozess_schritte_teilprozess_link_objekt
  check (teilprozess_link is null or jsonb_typeof(teilprozess_link) = 'object');

alter table prozess_uebergaenge
  add constraint prozess_uebergaenge_bedingung_objekt
  check (bedingung is null or jsonb_typeof(bedingung) = 'object');
