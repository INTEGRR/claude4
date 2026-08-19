-- Der Verkauf als komponierte Kette — das Spiegelbild des Einkaufs (0050):
--
--   Angebot → Positionen → Bestätigen
--     → Teilprozess LIEFERUNG (der Versandprozess am Ausgangs-Transfer)
--     → Ende
--
-- Mit der Bestätigung legt confirm_sales_order den Ausgangs-Transfer an,
-- genau wie die Bestellbestätigung den Eingangs-Transfer. Bisher endete
-- der Verkauf trotzdem an einer offenen Kante („Lieferung läuft") — der
-- Versand lief als eigener Prozess DANEBEN. Jetzt hängt er als Kindprozess
-- IN der Kette: der Auftrag ist erst fertig, wenn die Ware raus ist, und
-- das Diagramm zeigt dem Kunden seinen echten Ablauf von Anfang bis Ende.
--
-- Der Versandprozess behält den Code 'shopify_bestellung_versand' (technische
-- ID, von prozess_instanzen und vorgaenge referenziert), bekommt aber einen
-- neutralen Anzeigenamen: sein Beleg-Filter (origin_model = sales_order)
-- deckt seit 0050 JEDEN Verkaufsauftrag ab, nicht nur Shop-Bestellungen.
--
-- Bewusste Grenze: nach der Lieferung endet die Kette. Eine Abrechnung
-- fehlt, weil es kein Kundenrechnungs-Modul gibt (siehe 0052: die
-- invoice_status-Kachel wurde aus demselben Grund entfernt). Kommt ein
-- AR-Modul, kommt der Abrechnungs-Teilprozess dahinter — wie im Einkauf.

update prozesse
set name = 'Lieferung & Versand',
    beschreibung = 'Vom bestätigten Auftrag über Reservierung und Label bis zum '
                || 'gebuchten Warenausgang — mit Shop-Rückmeldung, wenn die '
                || 'Bestellung aus dem Shop kam. Läuft als Teilprozess im Verkauf.'
where code = 'shopify_bestellung_versand';

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('verkauf', 'migration:0064');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, teilprozess, zustand, optional)
  values
    -- Ohne eigenen Belegzustand: der Auftrag bleibt „sale"; der Fortschritt
    -- kommt aus dem Kindbeleg (delivery_status folgt dem Transfer).
    (v_neu, 'lieferung', 'Lieferung', 'prozess', 40,
     null, 'shopify_bestellung_versand', null, false);

  -- Die alte Abkürzung ans Ende weicht der Kette über den Teilprozess.
  delete from prozess_uebergaenge
  where version_id = v_neu and von_code = 'bestaetigen' and nach_code = 'ende';

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'bestaetigen', 'lieferung', 10, 'Ware raus'),
    (v_neu, 'lieferung',   'ende',      10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
