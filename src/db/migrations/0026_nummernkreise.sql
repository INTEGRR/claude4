-- ===========================================================================
-- Nummernkreise ohne Verklemmung
-- ===========================================================================
--
-- Bisher zählte next_sequence() in einer Tabellenzeile hoch:
--
--   select * into s from sequences where code = p_code for update;
--   update sequences set next_number = next_number + 1 ...
--
-- Die Zeilensperre hält bis zum Ende der umgebenden Transaktion. Ziehen zwei
-- gleichzeitige Vorgänge zwei Nummernkreise in unterschiedlicher Reihenfolge
-- — der eine erst „delivery", dann „receipt", der andere umgekehrt —, warten
-- beide aufeinander und PostgreSQL bricht einen mit 40P01 ab. Das ist kein
-- theoretischer Fall: eine Lieferung mit Retoure und ein gleichzeitiger
-- Wareneingang genügen. Reproduziert in zwei Sitzungen, siehe Test
-- „Nummernkreise verklemmen sich nicht".
--
-- Echte PostgreSQL-Sequenzen sind nicht transaktionsgebunden: nextval()
-- sperrt nichts und wartet auf niemanden. Der Preis ist eine mögliche Lücke
-- in der Belegnummer, wenn ein Vorgang abgebrochen wird. Lücken sind für uns
-- unkritisch — ein blockierter Packtisch nicht.

-- Für jeden bestehenden Nummernkreis eine echte Sequenz, die dort weiterzählt,
-- wo die Tabelle steht.
do $$
declare r record;
begin
  for r in select code, next_number from sequences loop
    execute format('create sequence if not exists %I start with %s',
                   'seq_' || r.code, greatest(r.next_number, 1));
  end loop;
end $$;

-- Neue Nummernkreise (etwa aus späteren Migrationen) bekommen ihre Sequenz
-- automatisch — sonst liefe next_sequence() ins Leere.
create or replace function sequence_backing_create() returns trigger
language plpgsql as $$
begin
  execute format('create sequence if not exists %I start with %s',
                 'seq_' || new.code, greatest(new.next_number, 1));
  return new;
end $$;

drop trigger if exists sequences_backing on sequences;
create trigger sequences_backing after insert on sequences
  for each row execute function sequence_backing_create();

/*
 * Nächste Belegnummer eines Kreises.
 *
 * next_number in der Tabelle ist ab hier nur noch der Startwert; der laufende
 * Stand steht in der Sequenz und wird über sequence_state() gelesen.
 */
create or replace function next_sequence(p_code text) returns text
language plpgsql as $$
declare
  s     sequences%rowtype;
  v_num bigint;
begin
  select * into s from sequences where code = p_code;
  if not found then
    raise exception 'Unbekannter Nummernkreis: %', p_code;
  end if;

  v_num := nextval('seq_' || p_code);
  return s.prefix || lpad(v_num::text, s.padding, '0');
end $$;

/*
 * Stand aller Nummernkreise für die Einstellungen-Seite: welche Nummer wird
 * als Nächstes vergeben?
 */
create or replace function sequence_state()
returns table (code text, prefix text, padding int, next_number bigint)
language plpgsql stable as $$
declare r record;
begin
  for r in select s.code, s.prefix, s.padding from sequences s order by s.code loop
    code    := r.code;
    prefix  := r.prefix;
    padding := r.padding;
    -- last_value ist vor dem ersten nextval() der Startwert selbst, danach die
    -- zuletzt vergebene Nummer. is_called unterscheidet die beiden Fälle.
    execute format(
      'select case when is_called then last_value + 1 else last_value end from %I',
      'seq_' || r.code) into next_number;
    return next;
  end loop;
end $$;
