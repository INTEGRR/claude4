-- Befund aus dem KI-Chat: die empfohlene Stellschraube (Overrides auf
-- „Rechnung erstellen" und „Lieferantenrechnung") war nicht klickbar,
-- weil beide Schritte als Pflicht markiert sind — abschalten lassen sich
-- nur OPTIONALE Schritte. Wer vorab zahlt und die Rechnung außerhalb
-- (DATEV) ablegt, braucht genau diesen Schalter: Einkauf Version 3 macht
-- beide Schritte optional. Standard bleibt AN — abgeschaltet wird bewusst
-- je Firma auf /prozesse/einkauf_wareneingang_rechnung; danach endet der
-- Vorgang mit dem gebuchten Wareneingang (abgeschaltete optionale
-- Schritte werden durchlaufen, die Nachfolger rücken nach).

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkauf_wareneingang_rechnung', 'migration:0051');

  update prozess_schritte
  set optional = true
  where version_id = v_neu and code in ('rechnung', 'abrechnung');

  perform prozess_version_aktivieren(v_neu);
end $$;
