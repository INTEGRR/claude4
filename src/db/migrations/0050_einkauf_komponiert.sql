-- Der Einkauf als erste KOMPONIERTE Prozesskette (Pilot für 0049):
--
--   [Start: Meldebestand erreicht] → Beschaffen        ┐
--   [Start: Bedarf erkannt]        → Bestellung anlegen ┴→ Bestellen
--     → Teilprozess WARENEINGANG (eigener Prozess am Eingangs-Transfer)
--     → Rechnung erstellen
--     → Teilprozess LIEFERANTENRECHNUNG (bestehender Prozess)
--     → Ende
--
-- Der Wareneingang bekommt dafür seinen eigenen kleinen Prozess auf dem
-- Eingangs-Transfer (validieren/buchen, Storno als Ausstieg) — Eingangs-
-- und Ausgangs-Transfers teilen sich die Belegart, der Beleg-Filter
-- trennt sie (origin purchase_order vs. sales_order).

-- --- Wareneingang: eigener Prozess am Eingangs-Transfer ----------------------

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell, beleg_filter)
  values ('wareneingang', 'Wareneingang',
          'Vom avisierten Eingang bis zur gebuchten Einlagerung — läuft als Teilprozess im Einkauf.',
          'lager', 'stock_picking',
          '{"feld": "origin_model", "op": "=", "wert": "purchase_order"}')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand, t.optional
  from v, (values
    ('start',      'Lieferung avisiert',      'start',  0,  null,                      null,     false),
    ('buchen',     'Wareneingang validieren', 'aktion', 10, 'lager.transfer_buchen',   'done',   false),
    ('stornieren', 'Stornieren',              'aktion', 80, 'lager.transfer_stornieren', 'cancel', true),
    ('ende',       'Eingelagert',             'ende',   90, null,                      null,     false)
  ) as t(code, name, art, seq, aktion, zustand, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',      'buchen',     10, null),
  ('start',      'stornieren', 90, 'Abbruch'),
  ('buchen',     'ende',       10, null),
  ('stornieren', 'ende',       10, null)
) as t(von, nach, seq, text);

-- Ausgangs-Transfers gehören weiter dem Shop-Versandprozess — jetzt explizit.
update prozesse
set beleg_filter = '{"feld": "origin_model", "op": "=", "wert": "sales_order"}'
where code = 'shopify_bestellung_versand';

-- Der Wareneingang gehört in dieselben Pakete wie der Einkauf.
update prozess_pakete
set prozess_codes = prozess_codes || '{wareneingang}'
where 'einkauf_wareneingang_rechnung' = any(prozess_codes)
  and not ('wareneingang' = any(prozess_codes));

-- --- Einkauf V2: zwei Starts + zwei Teilprozesse -----------------------------

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkauf_wareneingang_rechnung', 'migration:0050');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, teilprozess, teilprozess_link, zustand, optional)
  values
    (v_neu, 'start_meldebestand', 'Meldebestand erreicht', 'start', 1,
     null, null, null, null, false),
    -- Erzeugt die Bestellung aus dem Beschaffungsvorschlag (recordId =
    -- die Meldebestand-Regel). Ohne eigenen Belegzustand: der entstandene
    -- Entwurf steht wie ein manuell angelegter bei „Bestellung anlegen".
    (v_neu, 'beschaffen', 'Beschaffung ausführen', 'aktion', 5,
     'lager.beschaffung_ausfuehren', null, null, null, false),
    -- Ohne Belegzustand: die Bestellung bleibt „purchase" (done ist der
    -- manuelle Sperr-Zustand); der Fortschritt kommt aus dem Kindbeleg.
    (v_neu, 'wareneingang', 'Wareneingang', 'prozess', 35,
     null, 'wareneingang', null, null, false),
    (v_neu, 'abrechnung', 'Lieferantenrechnung', 'prozess', 50,
     null, 'lieferantenrechnung', '{"spalte": "purchase_order_id"}'::jsonb, null, false);

  -- Alte Direktkanten weichen der Kette über die Teilprozesse.
  delete from prozess_uebergaenge
  where version_id = v_neu
    and ((von_code = 'bestaetigen' and nach_code = 'rechnung')
      or (von_code = 'rechnung' and nach_code = 'ende'));

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'start_meldebestand', 'beschaffen',   10, null),
    (v_neu, 'beschaffen',         'position',     10, 'Positionen ergänzen'),
    (v_neu, 'beschaffen',         'bestaetigen',  20, null),
    (v_neu, 'bestaetigen',        'wareneingang', 10, 'Ware kommt an'),
    (v_neu, 'wareneingang',       'rechnung',     10, null),
    -- Der Beleg bleibt zustandsseitig bei „Bestellen" stehen — damit die
    -- Abrechnung nach der Rechnungserstellung angeboten wird, hängt sie
    -- direkt am durchlaufenen Wareneingang (wie Label → Buchen im Versand).
    (v_neu, 'wareneingang',       'abrechnung',   20, null),
    (v_neu, 'rechnung',           'abrechnung',   10, null),
    (v_neu, 'abrechnung',         'ende',         10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
