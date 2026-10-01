-- ============================================================================
-- 0103  Das Label bucht aus
-- ----------------------------------------------------------------------------
-- Bisher erzeugte „Label erstellen" nur das Label; Warenausgang und
-- Shop-Rückmeldung kamen erst mit einem eigenen Buchen-Schritt bzw. — im
-- Massendruck — mit einem Haken „direkt ausbuchen". Ohne Haken blieb die
-- Ware im Lager stehen und Shopify erfuhr nichts vom Versand.
--
-- Jetzt gilt: sobald das Label rausgeht, ist die Ware weg. Der Label-
-- Schritt bucht den Warenausgang mit (wie der Packtisch, 0075), verbraucht
-- die Kartonage und reiht die Shop-Rückmeldung mit der Sendungsnummer ein.
-- „Nur Label" ist der bewusste Ausnahmefall (Haken), danach bleibt der
-- Buchen-Schritt angeboten.
--
-- Die Logik sitzt in der Aktion (versand.label_erstellen); hier bekommt
-- nur der Prozess eine neue Version, deren Kante Label → Buchen das sagt.
-- Entscheidungslog 2026-10-01, „Label bucht aus".
-- ============================================================================

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0103');

  update prozess_uebergaenge
     set beschriftung = 'bucht automatisch mit'
   where version_id = v_neu and von_code = 'label' and nach_code = 'buchen';

  perform prozess_version_aktivieren(v_neu);
end $$;
