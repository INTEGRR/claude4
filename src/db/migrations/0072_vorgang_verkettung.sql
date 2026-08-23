-- ===========================================================================
-- 0072  Vorgang ↔ Fachbeleg: Herkunft, Verkettbarkeits-Wächter, Muster-Kette
-- ===========================================================================
-- Der Pilot hat einen Angebots-Vorgang bis „Vertrag abgeschlossen" gebracht —
-- und das war buchstäblich das Ende: ein Textzustand, aus dem nichts folgt.
-- Die Teilprozess-Mechanik (0049) findet Kindbelege über origin_model/
-- origin_id oder eine Link-Spalte; beides gab es weder an sales_orders noch
-- an vorgaenge. Schlimmer: ein Teilprozess-Schritt auf einen unverkettbaren
-- Beleg ließ sich klaglos entwerfen UND aktivieren — der Fehler zeigte sich
-- erst als SQL-Fehler (undefined_column) mitten im Panel des Kundenbelegs.
--
-- Drei Dinge, alle nach bestehendem Muster:
--
--  1. HERKUNFT: origin_model/origin_id/origin_label an sales_orders UND an
--     vorgaenge (Muster stock_pickings, 0003). Damit kann ein Auftrag am
--     Vorgang hängen (Angebot → Auftrag → Lieferung in EINEM Diagramm) und
--     ein Vorgang selbst Kind sein — Vorgang↔Vorgang und Fachbeleg↔Vorgang
--     folgen demselben Muster, ohne je wieder eine Migration zu brauchen.
--  2. WÄCHTER: prozess_version_aktivieren prüft ab jetzt die Verkettbarkeit
--     jedes Teilprozess-Schritts und sagt verständlich, was fehlt. Dazu
--     beleg_existiert() als Grundlage für die Modellprüfung des Torwächters.
--  3. MUSTER-KETTE: der gesäte 'anfrage'-Prozess bekommt Version 2 mit
--     „Auftrag anlegen" (vorgang.auftrag_anlegen, Zustand 'gewonnen') und
--     dem Teilprozess 'verkauf' — die Vorlage, an der jeder künftige
--     Laufzeit-Prozess das Verketten ablesen kann. prozesse.aktiv bleibt
--     unangetastet: wo die Anfrage aus ist, bleibt sie aus.

-- --- 1. Herkunft ------------------------------------------------------------

alter table sales_orders
  add column origin_model text,
  add column origin_id    uuid,
  add column origin_label text;

comment on column sales_orders.origin_model is
  'Herkunftsbeleg (z. B. ''vorgang''): der Auftrag entstand aus diesem Beleg — Grundlage der Teilprozess-Verkettung (teilprozess_stand) und der herkunft_*-Bedingungsfelder.';
comment on column sales_orders.origin_label is
  'Belegnummer der Herkunft im Klartext für Listen/Drucke (Muster stock_pickings).';

create index sales_orders_origin_idx on sales_orders (origin_model, origin_id)
  where origin_id is not null;

-- Idempotenz hart in der Datenbank: höchstens EIN Auftrag je Vorgang —
-- vorgang.auftrag_anlegen verlinkt bei erneutem Klick den bestehenden.
create unique index sales_orders_ein_auftrag_je_vorgang
  on sales_orders (origin_id) where origin_model = 'vorgang';

alter table vorgaenge
  add column origin_model text,
  add column origin_id    uuid,
  add column origin_label text;

comment on column vorgaenge.origin_model is
  'Herkunftsbeleg: dieser Vorgang entstand aus einem anderen Beleg (auch einem anderen Vorgang) — damit sind Laufzeit-Prozesse untereinander und mit Fachbelegen verkettbar.';

create index vorgaenge_origin_idx on vorgaenge (origin_model, origin_id)
  where origin_id is not null;

-- --- 2a. Existenz-/Modellprüfung für den Torwächter ---------------------------

/*
 * Gehört die übergebene Beleg-ID wirklich zum Modell der Aktion? Der
 * Torwächter prüfte bisher nur die UUID-Form — eine Fremdaktion mit der
 * falschen Beleg-ID lief bis in die Fachfunktion und scheiterte dort
 * unverständlich. Modelle ohne prozess_modelle-Eintrag sind nicht prüfbar
 * und werden bewusst durchgelassen (kein stiller Riegel für Unbekanntes).
 */
create or replace function beleg_existiert(p_modell text, p_id uuid)
returns boolean
language plpgsql stable as $$
declare
  v_tabelle text;
  v_ok boolean;
begin
  select m.tabelle into v_tabelle from prozess_modelle m where m.modell = p_modell;
  if v_tabelle is null then return true; end if;
  execute format('select exists(select 1 from %I where id = $1)', v_tabelle)
    using p_id into v_ok;
  return v_ok;
end $$;

-- --- 2b. Aktivierung prüft Verkettbarkeit ------------------------------------

-- Vollständig übernommen aus 0049 (Starts/Enden, Teilprozess-Existenz,
-- XOR-Regeln, Zustands-Eindeutigkeit, Erreichbarkeit, Azyklik) — NEU ist der
-- Verkettbarkeits-Block: ein Teilprozess-Schritt, dessen Kindbeleg nicht am
-- Elternbeleg hängen KANN, wird abgelehnt statt später im Panel zu crashen.
create or replace function prozess_version_aktivieren(p_version uuid)
returns void
language plpgsql as $$
declare
  v_prozess uuid;
  v_code text;
  v_modell text;
  v_start int;
  v_ende int;
  gesamt int;
  erreicht text[];
  rest int;
  neu text[];
  r record;
  v_kind_modell text;
  v_kind_tabelle text;
begin
  select v.prozess_id, p.code, p.modell into v_prozess, v_code, v_modell
  from prozess_versionen v join prozesse p on p.id = v.prozess_id
  where v.id = p_version;
  if v_prozess is null then raise exception 'Unbekannte Version'; end if;

  select count(*) filter (where art = 'start'),
         count(*) filter (where art = 'ende'),
         count(*)
    into v_start, v_ende, gesamt
  from prozess_schritte where version_id = p_version;

  -- Mehrfach-Starts sind erlaubt (mehrere Einstiege, z. B. Meldebestand
  -- UND manueller Bedarf) — nur ganz ohne Start geht es nicht.
  if v_start < 1 then raise exception 'Ein Prozess braucht mindestens einen Startschritt'; end if;
  if v_ende < 1 then raise exception 'Ein Prozess braucht mindestens einen Endschritt'; end if;

  -- Teilprozess-Verweise: existieren, nicht rekursiv — und VERKETTBAR.
  for r in
    select s.code, s.teilprozess, s.teilprozess_link from prozess_schritte s
    where s.version_id = p_version and s.art = 'prozess'
  loop
    if r.teilprozess = v_code then
      raise exception 'Teilprozess-Schritt „%" verweist auf den eigenen Prozess', r.code;
    end if;
    if not exists (select 1 from prozesse p where p.code = r.teilprozess) then
      raise exception 'Teilprozess-Schritt „%": Prozess „%" existiert nicht', r.code, r.teilprozess;
    end if;

    -- Verkettbarkeit: teilprozess_stand findet Kindbelege über origin-Spalten
    -- oder die teilprozess_link-Spalte. Fehlt beides, wartet der Schritt für
    -- immer — oder schlimmer, das Panel bricht mit undefined_column.
    if v_modell is null then
      raise exception
        'Teilprozess-Schritt „%": der Prozess ist beleglos — ohne Elternbeleg kann kein Kindbeleg an ihm hängen',
        r.code;
    end if;
    select p.modell into v_kind_modell from prozesse p where p.code = r.teilprozess;
    if v_kind_modell is null then
      raise exception
        'Teilprozess-Schritt „%": „%" ist beleglos — ein Teilprozess braucht einen Beleg, der am Elternbeleg hängen kann',
        r.code, r.teilprozess;
    end if;
    select m.tabelle into v_kind_tabelle from prozess_modelle m where m.modell = v_kind_modell;
    if v_kind_tabelle is null then
      raise exception 'Teilprozess-Schritt „%": Modell „%" hat keinen prozess_modelle-Eintrag',
        r.code, v_kind_modell;
    end if;
    if r.teilprozess_link ? 'spalte' then
      if not exists (
        select 1 from pg_attribute
        where attrelid = to_regclass(v_kind_tabelle)
          and attname = r.teilprozess_link ->> 'spalte' and not attisdropped
      ) then
        raise exception
          'Teilprozess-Schritt „%": Tabelle „%" hat keine Spalte „%" (teilprozess_link)',
          r.code, v_kind_tabelle, r.teilprozess_link ->> 'spalte';
      end if;
    elsif not exists (
      select 1 from pg_attribute
      where attrelid = to_regclass(v_kind_tabelle)
        and attname = 'origin_model' and not attisdropped
    ) then
      raise exception
        'Teilprozess-Schritt „%": Belege „%" (Tabelle %) können nicht am Elternbeleg hängen — der Tabelle fehlen origin_model/origin_id, und ein teilprozess_link {"spalte": …} ist nicht gesetzt',
        r.code, r.teilprozess, v_kind_tabelle;
    end if;
  end loop;

  -- Kanten müssen auf existierende Schritte zeigen (FK deckt das ab) und
  -- XOR-Regeln einhalten.
  for r in
    select u.von_code,
           count(*) filter (where u.bedingung is null) as ohne,
           max(u.sequence) filter (where u.bedingung is null) as ohne_seq,
           max(u.sequence) as max_seq
    from prozess_uebergaenge u
    join prozess_schritte s on s.version_id = u.version_id and s.code = u.von_code
    where u.version_id = p_version and s.art = 'xor'
    group by u.von_code
  loop
    if r.ohne > 1 then
      raise exception 'XOR %: höchstens eine bedingungslose Default-Kante', r.von_code;
    end if;
    if r.ohne = 1 and r.ohne_seq < r.max_seq then
      raise exception 'XOR %: die Default-Kante muss die letzte sein', r.von_code;
    end if;
  end loop;

  -- Doppelt gemappte Zustände machen den Belegstandort mehrdeutig.
  for r in
    select zustand, count(*) as n from prozess_schritte
    where version_id = p_version and zustand is not null
    group by zustand having count(*) > 1
  loop
    raise exception 'Zustand „%" ist % Schritten zugeordnet — je Version nur einem', r.zustand, r.n;
  end loop;

  -- Erreichbarkeit über Fixpunkt-Iteration von ALLEN Starts aus.
  select array_agg(code) into erreicht from prozess_schritte
  where version_id = p_version and art = 'start';
  for rest in 1 .. gesamt loop
    select array_agg(distinct u.nach_code) into neu
    from prozess_uebergaenge u
    where u.version_id = p_version
      and u.von_code = any(erreicht)
      and not (u.nach_code = any(erreicht));
    exit when neu is null;
    erreicht := erreicht || neu;
  end loop;
  if array_length(erreicht, 1) < gesamt then
    raise exception 'Nicht alle Schritte sind von einem Start aus erreichbar (%/%)',
      array_length(erreicht, 1), gesamt;
  end if;

  -- Azyklik: Kahn-Abbau — bleiben Kanten übrig, gibt es eine Schleife.
  declare
    knoten text[];
    ohne_eingang text[];
  begin
    select array_agg(code) into knoten from prozess_schritte where version_id = p_version;
    for rest in 1 .. gesamt loop
      select array_agg(s.code) into ohne_eingang
      from prozess_schritte s
      where s.version_id = p_version and s.code = any(knoten)
        and not exists (
          select 1 from prozess_uebergaenge u
          where u.version_id = p_version and u.nach_code = s.code
            and u.von_code = any(knoten));
      exit when ohne_eingang is null;
      knoten := (select array_agg(k) from unnest(knoten) k where not (k = any(ohne_eingang)));
      exit when knoten is null;
    end loop;
    if knoten is not null and array_length(knoten, 1) > 0 then
      raise exception 'Der Prozess enthält eine Schleife (%: Schleifen sind nicht erlaubt)',
        array_to_string(knoten, ', ');
    end if;
  end;

  update prozess_versionen set status = 'archiviert'
  where prozess_id = v_prozess and status = 'aktiv';
  update prozess_versionen set status = 'aktiv', aktiviert_am = now()
  where id = p_version;
end $$;

-- --- 3. Muster-Kette: anfrage v2 ----------------------------------------------

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('anfrage', 'migration:0072');

  insert into prozess_schritte
    (version_id, code, name, art, sequence, aktion, teilprozess, zustand, params, optional)
  values
    (v_neu, 'auftrag', 'Auftrag anlegen', 'aktion', 32,
     'vorgang.auftrag_anlegen', null, 'gewonnen', '{"state": "gewonnen"}', false),
    (v_neu, 'verloren', 'Kein Auftrag', 'aktion', 34,
     'vorgang.status_setzen', null, 'verloren', '{"state": "verloren"}', false),
    -- Ohne eigenen Belegzustand: der Vorgang bleibt „gewonnen", der
    -- Fortschritt kommt aus dem Kindbeleg (Muster 0064, Schritt 'lieferung').
    (v_neu, 'abwicklung', 'Auftrag & Lieferung', 'prozess', 36,
     null, 'verkauf', null, '{}', false);

  -- DESTRUKTIV: betrifft nur die soeben KOPIERTE, noch inaktive Version —
  -- die Kante angebot→ende weicht der Kette über Auftrag/verloren.
  delete from prozess_uebergaenge
  where version_id = v_neu and von_code = 'angebot' and nach_code = 'ende';

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_neu, 'angebot',    'auftrag',    10, 'Auftrag erteilt'),
    (v_neu, 'angebot',    'verloren',   20, 'kein Auftrag'),
    (v_neu, 'auftrag',    'abwicklung', 10, null),
    (v_neu, 'abwicklung', 'ende',       10, null),
    (v_neu, 'verloren',   'ende',       10, null);

  perform prozess_version_aktivieren(v_neu);
end $$;
