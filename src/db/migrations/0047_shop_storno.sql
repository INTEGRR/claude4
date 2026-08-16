-- BUG/00001: Ein im ERP stornierter Shop-Auftrag wird jetzt in Shopify
-- nachgezogen (orderCancel mit Restock; die Rückerstattung bleibt bewusst
-- ein manueller Schritt im Shop). Der Verkaufsprozess zeigt das als
-- dienst-Schritt im Storno-Zweig — nur für Shop-Aufträge (bedingung auf
-- source), manuelle Aufträge enden wie bisher direkt.

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('verkauf', 'migration:0047');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, job_kind, optional)
  values
    (v_neu, 'shop_storno', 'Storno an den Shop melden', 'dienst', 85,
     'shopify_order_cancel', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_neu, 'stornieren', 'shop_storno', 5,
     '{"feld": "source", "op": "=", "wert": "shopify"}'::jsonb, 'Shop-Auftrag'),
    (v_neu, 'shop_storno', 'ende', 10, null, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
