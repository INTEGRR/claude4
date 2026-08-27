-- Packtisch als EIN Prozessschritt: am Packtisch wird der Versand-Barcode
-- des Zettels gescannt, die Positionen werden gegengescannt, und die
-- Aktion versand.packtisch_abschliessen erledigt Label + Warenausgang +
-- Kartonage + Shop-Rückmeldung in einem Zug. Die bisherigen Einzelwege
-- label/buchen bleiben als Handweg bestehen.
--
-- Der Schritt trägt bewusst KEINEN eigenen zustand: `done` gehört dem
-- Schritt „buchen" (je Version genau ein Schritt je Zustand — der
-- Belegstatus bleibt die einzige Wahrheit). Der Packtisch wird aus
-- `assigned` heraus angeboten; nach seiner Ausführung steht der Beleg
-- über den Zustand automatisch auf „Warenausgang gebucht" — genau das
-- hat die Aktion ja getan. Muster wie 0047/0048, rein additiv.

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0075');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion)
  values
    (v_neu, 'packtisch', 'Packtisch: scannen & abschließen', 'aktion', 35,
     'versand.packtisch_abschliessen');

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'verfuegbarkeit', 'packtisch', 15, 'Packtisch-Scan'),
    (v_neu, 'packtisch', 'buchen', 10, 'bucht automatisch mit');

  perform prozess_version_aktivieren(v_neu);
end $$;
