-- Die Klärliste wird ein PROZESSSCHRITT: der Shopify-Prozess bekommt als
-- Version 2 (über die Versionsmaschine, wie die Fertigung in 0044) einen
-- matching-Schritt zwischen Bestellung und Verfügbarkeit — Auflöse-Aktion
-- ist die registrierte integrationen.klaerfall_aufloesen.
--
-- Dazu die Heilung: eine aufgelöste Klärzeile wird als Position an den noch
-- unbestätigten Auftrag NACHGEZOGEN (echter Preis aus der Shop-Bestellung),
-- danach wird bei Bezahlung bestätigt — attached_at hält fest, was schon
-- übernommen ist, damit Reconcile-Läufe idempotent bleiben.

alter table shopify_unmatched_lines add column attached_at timestamptz;

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0046');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, matching_tabelle, optional)
  values
    (v_neu, 'klaerung', 'Klärliste auflösen', 'matching', 15,
     'integrationen.klaerfall_aufloesen', 'shopify_unmatched_lines', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'bestellung', 'klaerung', 5, 'unbekannte SKU'),
    (v_neu, 'klaerung', 'verfuegbarkeit', 10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
