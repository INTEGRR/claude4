-- ============================================================================
-- 0091  Kommissionieren — Packzettel auf Papier und Sammel-Screen am Handy
-- ----------------------------------------------------------------------------
-- Bisher ging im Versand nur „filtern und Labels drucken". Es fehlte das
-- Abarbeiten Bestellung für Bestellung: mit dem Packzettel durchs Lager
-- (analog) oder mit dem Handy/Tablet, Artikel für Artikel gescannt
-- (digital) — danach zum Packtisch, der wie gehabt jeden Artikel noch
-- einmal als Kontrolle scannt (Entscheidungslog 2026-09-29).
--
--   * Belegstatus bleibt die einzige Wahrheit: die Lieferung bleibt
--     'assigned'. „Kommissioniert" ist eine Tatsache am Beleg (Spalten),
--     kein zweiter Zustand — Muster Packtisch (0075).
--   * stock_moves.qty_kommissioniert hält den Sammelfortschritt je Zeile,
--     getrennt von qty_done (das bucht erst picking_validate).
--   * kommissionierung_von/_seit: wer gerade sammelt — zwei Sammler an
--     derselben Bestellung sind ausgeschlossen.
--   * Neuer OPTIONALER Prozessschritt 'kommissionieren' zwischen
--     Verfügbarkeit und Packtisch — je Firma abschaltbar; der direkte Weg
--     Verfügbarkeit → Packtisch bleibt.
-- ============================================================================

alter table stock_pickings
  add column kommissioniert_am timestamptz,
  add column kommissioniert_von text,
  add column kommissionierung_von text,
  add column kommissionierung_seit timestamptz,
  add column packzettel_gedruckt_am timestamptz;

comment on column stock_pickings.kommissioniert_am is
  'Ware vollständig gesammelt (Kommissionieren, 0091) — die Lieferung bleibt assigned bis zum Warenausgang';
comment on column stock_pickings.kommissionierung_von is
  'Wer die Lieferung gerade sammelt (Sperre gegen zwei Sammler); mit kommissionierung_seit';
comment on column stock_pickings.packzettel_gedruckt_am is
  'Zuletzt als Packzettel gedruckt (Sammeldruck oder Druckbrücke)';

alter table stock_moves
  add column qty_kommissioniert numeric(16,4) not null default 0 check (qty_kommissioniert >= 0);
comment on column stock_moves.qty_kommissioniert is
  'Gesammelte Menge beim Kommissionieren (0091) — Fortschritt, keine Buchung';

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0091');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, optional)
  values
    (v_neu, 'kommissionieren', 'Kommissionieren (Ware sammeln)', 'aktion', 32,
     'lager.kommissionieren', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'verfuegbarkeit', 'kommissionieren', 12, 'Ware sammeln'),
    (v_neu, 'kommissionieren', 'packtisch', 10, 'zum Packtisch');

  perform prozess_version_aktivieren(v_neu);
end $$;
