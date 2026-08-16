-- BUG/00003: Der Shop-Prozess zeigt den Weg „fertigen auf Bestellung"
-- als sichtbaren Zweig. Die Automatik existiert seit jeher: die Bestätigung
-- legt für Positionen mit route_manufacture + route_mto (und Stückliste)
-- den Fertigungsauftrag an. Neu ist der ereignis-Schritt im Prozess —
-- ohne eigenen Belegzustand (die Lieferung bleibt unreserviert stehen,
-- bis das Erzeugnis da ist; das Reservieren übernimmt wie gehabt der
-- Verfügbarkeits-Schritt).

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0048');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, ereignis, optional)
  values
    (v_neu, 'fertigen', 'Fertigung läuft (auf Bestellung)', 'ereignis', 12,
     'fertigung:bereitgestellt', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'bestellung', 'fertigen', 7, 'erst fertigen (MTO)'),
    (v_neu, 'fertigen', 'verfuegbarkeit', 10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
