-- ===========================================================================
-- Eröffnungsbewertung für bestehende Datenbanken nachholen
-- ===========================================================================
-- Migration 0018 hat die Bestandsbewertung eingeführt, 0020 die Funktion zum
-- Bewerten von Altbestand. Aufgerufen wurde sie aber nur beim Anlegen der
-- Beispieldaten — eine Datenbank, die schon vor 0018 bestand, blieb damit
-- ohne eine einzige Wertschicht:
--
--   * Bestandswert und Deckungsbeitrag standen überall auf 0,
--   * Abgänge daraus wären mit 0 € bewertet worden,
--   * mv_stock_value_history und die Kennzahlen blieben leer.
--
-- Deshalb hier einmalig nachziehen. Die Funktion ist wiederholbar und rührt
-- bereits bewertete Mengen nicht an: Wer schon Wertschichten hat, merkt von
-- dieser Migration nichts, und auf einer frischen Installation läuft sie ins
-- Leere, weil zu diesem Zeitpunkt noch kein Bestand existiert.

do $$
declare v_anzahl int;
begin
  select count(*) into v_anzahl from valuation_initialize(null, 'migration 0024');

  if v_anzahl > 0 then
    raise notice 'Eröffnungsbewertung nachgeholt: % Position(en) bewertet.', v_anzahl;
    -- Die Kennzahlen bauen auf den Wertschichten auf und wären sonst bis zum
    -- nächtlichen Lauf weiter leer.
    perform refresh_analytics('migration 0024');
  end if;
end $$;
