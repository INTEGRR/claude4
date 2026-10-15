-- ============================================================================
-- 0111  Shop meldet Versand (extern, z. B. Sendcloud) — KRNL zieht nach
-- ----------------------------------------------------------------------------
-- Parallel zu KRNL läuft der Versand noch über Sendcloud: die Sendung
-- entsteht dort und landet in Shopify als Fulfillment — in KRNL blieb der
-- Auftrag „unfertig" (Lieferung offen, Fertigung offen). Jetzt zieht der
-- Shop-Abgleich nach: meldet Shopify eine bestehende Bestellung als
-- FULFILLED und KRNL hat selbst keine Sendung dazu, wird der Warenausgang
-- gebucht (Lieferung erledigt, Auftrag geliefert), die Trackingdaten stehen
-- an der Lieferung (extern_versand), und ein noch offener Fertigungsauftrag
-- wird zur Nachfrage ans Team Fertigung (Aufgabe): bauen inkl.
-- Materialverbrauch — oder stornieren und den Bestand korrigieren.
-- Entscheidungslog 2026-10-15.
-- ============================================================================

alter table stock_pickings add column if not exists extern_versand jsonb;
comment on column stock_pickings.extern_versand is
  'Versand außerhalb von KRNL (der Shop meldet das Fulfillment): {quelle, carrier, nummer, url, am, fulfillment_id} — null = Versand über KRNL';

-- Prozess: neuer Ereignisschritt „Im Shop versendet (extern)". Der Shop kann
-- jederzeit vor dem eigenen Warenausgang melden; danach ist der Warenausgang
-- gebucht — ohne eigene Shop-Rückmeldung (die hat der Shop ja schon).
do $$
declare
  v_neu uuid;
  v_shop constant jsonb := '{"feld": "herkunft_source", "op": "=", "wert": "shopify"}';
  v_extern constant jsonb := '{"feld": "extern_versand", "op": "nicht_leer"}';
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0111');

  insert into prozess_schritte (version_id, code, name, art, sequence, ereignis, optional)
  values (v_neu, 'shop_versendet', 'Im Shop versendet (extern)', 'ereignis', 37,
          'shop:bestellung_versendet', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  select v_neu, von, 'shop_versendet', 90, v_shop, 'Versand außerhalb (Shop meldet)'
  from unnest(array['bestellung', 'fertigen', 'verfuegbarkeit', 'kommissionieren']) as von;

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values (v_neu, 'shop_versendet', 'buchen', 10, null, 'Warenausgang gebucht'),
         (v_neu, 'buchen', 'ende', 5, v_extern, 'extern versendet');

  -- Die eigene Shop-Rückmeldung nur, wenn KRNL versendet hat.
  update prozess_uebergaenge
  set bedingung = jsonb_build_object('alle',
        jsonb_build_array(bedingung, '{"feld": "extern_versand", "op": "leer"}'::jsonb))
  where version_id = v_neu and von_code = 'buchen' and nach_code = 'fulfillment';

  perform prozess_version_aktivieren(v_neu);
end $$;
