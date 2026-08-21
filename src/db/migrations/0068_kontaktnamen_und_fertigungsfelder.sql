-- ===========================================================================
-- 0068  Vor-/Nachname am Kontakt + Fertigungsfelder am Verkaufsauftrag
-- ===========================================================================
-- Zwei Befunde aus dem Pilotbetrieb:
--
-- BUG/00013 „Name muss Vorname Nachname haben": Kontakte hatten genau ein
-- Namensfeld. Für Personen ist das zu wenig — Anrede, Sortierung und der
-- Shop (der first_name/last_name liefert) brauchen die Teile getrennt.
-- `name` bleibt der Anzeigename und die eine Wahrheit für Belege; die neuen
-- Spalten sind die Bestandteile, aus denen er bei Personen entsteht.
-- Bestandsdaten werden NICHT geraten: „Müller GmbH & Co. KG" oder
-- „Dr. Anna von Weiz" lassen sich nicht verlässlich zerlegen. Wer die Teile
-- braucht, pflegt sie beim nächsten Anfassen des Kontakts nach.
--
-- BUG/00015 „Prozessversion lässt sich nicht aktivieren": Der Kunde hat den
-- Verkaufsprozess von der KI umbauen lassen; sie hat einen XOR-Schritt
-- „Fertigung nötig?" mit ZWEI bedingungslosen Kanten gebaut. Der
-- Aktivierungs-Wächter lehnt das zu Recht ab (höchstens eine Default-Kante)
-- — nur ließ sich die Bedingung gar nicht formulieren: prozess_beleg_daten
-- liefert für einen Verkaufsauftrag nur dessen Spalten, und ob eine Position
-- gefertigt werden muss, steht in den Positionen.
--
-- Deshalb zwei abgeleitete Felder am Verkaufsauftrag:
--   fertigung_noetig       — mindestens eine Position ist fertigbar
--                            (route_manufacture + auflösbare Stückliste)
--   fertigung_automatisch  — mindestens eine Position wird bei der
--                            Bestätigung automatisch zum Fertigungsauftrag
--                            (zusätzlich route_mto)
--
-- Der Unterschied ist genau BUG/00014: ein Produkt mit Stückliste, aber ohne
-- „auf Bestellung fertigen", erzeugt keinen Auftrag. Bisher schwieg das
-- System dazu; jetzt ist der Unterschied abfragbar und die Oberfläche kann
-- ihn benennen.
--
-- Rein additiv.

alter table partners
  add column vorname  text,
  add column nachname text;

comment on column partners.vorname is
  'Vorname bei Personen (is_company = false). `name` bleibt der Anzeigename.';

-- prozess_beleg_daten: Herkunfts-Anreicherung wie in 0065, plus die beiden
-- Fertigungsfelder für Verkaufsaufträge.
create or replace function prozess_beleg_daten(p_modell text, p_id uuid)
returns jsonb language plpgsql stable as $$
declare
  m prozess_modelle%rowtype;
  v_daten jsonb;
  v_herkunft_tabelle text;
  v_herkunft jsonb;
  v_noetig boolean;
  v_auto boolean;
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

  -- Abgeleitete Felder aus den Positionen: ohne sie lässt sich der Zweig
  -- „Fertigung nötig?" im Verkaufsprozess nicht als Bedingung schreiben.
  if p_modell = 'sales_order' then
    select coalesce(bool_or(pt.route_manufacture and resolve_bom(l.variant_id) is not null), false),
           coalesce(bool_or(pt.route_manufacture and pt.route_mto
                            and resolve_bom(l.variant_id) is not null), false)
      into v_noetig, v_auto
    from sales_order_lines l
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where l.order_id = p_id;

    v_daten := v_daten || jsonb_build_object(
      'fertigung_noetig', coalesce(v_noetig, false),
      'fertigung_automatisch', coalesce(v_auto, false));
  end if;

  return v_daten;
end $$;

-- Warum eine Position keinen Fertigungsauftrag erzeugt — für die Oberfläche
-- und für die KI. Gibt genau die Positionen zurück, die fertigbar wären.
create or replace function sales_order_fertigungslage(p_order uuid)
returns table (
  line_id      uuid,
  variant_id   uuid,
  bezeichnung  text,
  hat_bom      boolean,
  route_manufacture boolean,
  route_mto    boolean,
  grund        text
) language sql stable as $$
  select l.id, l.variant_id, variant_display_name(l.variant_id),
         resolve_bom(l.variant_id) is not null,
         pt.route_manufacture, pt.route_mto,
         case
           when resolve_bom(l.variant_id) is null then 'keine Stückliste'
           when not pt.route_manufacture then 'Route „fertigen" ist am Produkt nicht gesetzt'
           when not pt.route_mto then 'Route „auf Bestellung fertigen" ist am Produkt nicht gesetzt'
           else null
         end
  from sales_order_lines l
  join product_variants pv on pv.id = l.variant_id
  join product_templates pt on pt.id = pv.template_id
  where l.order_id = p_order
    and (resolve_bom(l.variant_id) is not null or pt.route_manufacture)
  order by l.sequence, l.created_at;
$$;

comment on function sales_order_fertigungslage(uuid) is
  'Positionen, die fertigbar wären, mit dem Grund, warum kein Fertigungsauftrag entsteht (BUG/00014).';
