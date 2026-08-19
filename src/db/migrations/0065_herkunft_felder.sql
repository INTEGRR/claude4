-- Herkunftsfelder in den Belegdaten + der Versand-Befund, den 0064 freilegt.
--
-- BEFUND: Der Versandprozess verlangt die Shop-Rückmeldung (dienst-Schritt
-- 'fulfillment') von JEDEM Ausgangs-Transfer — auch von manuell erfassten
-- Aufträgen, die nie eine bekommen. Bisher fiel das nicht auf, weil der
-- Verkauf mit der Bestätigung endete („Lieferung läuft") und niemand den
-- Transfer bis ans Prozessende verfolgte. Seit der Verkauf komponiert ist
-- (0064), hängt genau daran die ganze Kette: der Auftrag würde ewig auf
-- eine Rückmeldung warten, die es nicht gibt.
--
-- URSACHE: Die Kante zum Rückmeldungs-Schritt kann nicht danach fragen, ob
-- der Auftrag aus dem Shop kam — Bedingungen sehen nur die Spalten des
-- eigenen Belegs, und am Transfer steht die Herkunft nur als
-- origin_model/origin_id.
--
-- FIX (generisch): Belege mit Herkunft bekommen die Felder des Herkunfts-
-- belegs flach unter dem Präfix `herkunft_` dazu. Damit kann jeder Prozess
-- am Kindbeleg auf den Elternbeleg schauen — fachlich richtig, denn der
-- Transfer gehört zum Auftrag. Rein additiv: bestehende Bedingungen und
-- Beleg-Filter sehen dieselben Felder wie vorher.

create or replace function prozess_beleg_daten(p_modell text, p_id uuid)
returns jsonb
language plpgsql stable as $$
declare
  m prozess_modelle%rowtype;
  v_daten jsonb;
  v_herkunft_tabelle text;
  v_herkunft jsonb;
begin
  select * into m from prozess_modelle where modell = p_modell;
  if not found then
    raise exception 'Unbekanntes Prozessmodell: %', p_modell;
  end if;
  execute format('select to_jsonb(t) from %I t where id = $1', m.tabelle)
    into v_daten using p_id;
  if v_daten is null then
    raise exception 'Datensatz % in % nicht gefunden', p_id, m.tabelle;
  end if;

  -- Herkunft anreichern: nur über den Modell-Katalog aufgelöst, damit auch
  -- hier nie ein Tabellenname aus Nutzerdaten in dynamisches SQL wandert.
  if v_daten ? 'origin_model' and v_daten ? 'origin_id'
     and v_daten ->> 'origin_model' is not null
     and v_daten ->> 'origin_id' is not null then
    select mm.tabelle into v_herkunft_tabelle
    from prozess_modelle mm where mm.modell = v_daten ->> 'origin_model';
    if v_herkunft_tabelle is not null then
      execute format('select to_jsonb(t) from %I t where id = $1', v_herkunft_tabelle)
        into v_herkunft using (v_daten ->> 'origin_id')::uuid;
      if v_herkunft is not null then
        select v_daten || jsonb_object_agg('herkunft_' || key, value)
          into v_daten
        from jsonb_each(v_herkunft);
      end if;
    end if;
  end if;

  return v_daten;
end $$;

-- Die Shop-Rückmeldung gilt jetzt nur noch für Shop-Aufträge; manuelle
-- Lieferungen sind mit dem gebuchten Warenausgang fertig. Muster wie der
-- Shop-Storno im Verkauf (0047): Bedingung an der Kante, Schritt optional.
do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('shopify_bestellung_versand', 'migration:0065');

  update prozess_schritte set optional = true
  where version_id = v_neu and code = 'fulfillment';

  update prozess_uebergaenge
  set bedingung = '{"feld": "herkunft_source", "op": "=", "wert": "shopify"}'::jsonb,
      beschriftung = 'Shop-Bestellung'
  where version_id = v_neu and von_code = 'buchen' and nach_code = 'fulfillment';

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values (v_neu, 'buchen', 'ende', 20, 'manueller Auftrag');

  perform prozess_version_aktivieren(v_neu);
end $$;
