-- Belegsignale folgen dem Prozessschritt: Felder wie billing_status bleiben
-- als FAKTEN am Beleg (Historie, Wieder-Einschalten findet alles wieder),
-- aber ihre SIGNALWIRKUNG — „hier fehlt noch etwas" — gilt nur, solange der
-- zugehörige Schritt Teil des Ablaufs ist. Diese Funktion ist die eine
-- Frage, die Oberflächen dafür stellen.

create or replace function prozessschritt_aktiv(p_prozess text, p_schritt text)
returns boolean
language sql stable as $$
  select exists (
    select 1 from prozess_schritte s
    where s.version_id = prozess_aktive_version(p_prozess)
      and s.code = p_schritt
  )
  and coalesce(
    (select o.aktiv from prozess_overrides o
     where o.prozess_code = p_prozess and o.schritt_code = p_schritt),
    true
  );
$$;

comment on function prozessschritt_aktiv is
  'Ist der Schritt Teil des aktiven Ablaufs (in der aktiven Version vorhanden und nicht per Override abgeschaltet)? Oberflächen koppeln Belegsignale daran.';
