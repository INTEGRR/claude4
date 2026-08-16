-- ===========================================================================
-- Bug-Loop: Seitenpfad → betroffener Prozess
-- ===========================================================================
--
-- Das Ticket-Schema (prozess_code, schritt_code, test_ok, test_befund,
-- test_commit_sha, test_gelaufen_am) stammt bereits aus 0036 — hier kommt
-- die Auflösung dazu: von welcher Seite gemeldet wurde, bestimmt den
-- betroffenen Prozess. Der Prozesstest weiß dann, was er durchspielen muss;
-- den Status „behoben" setzt weiterhin ein Mensch (oder Claude auf Zuruf),
-- nie der Test selbst.

-- Welcher Prozess gehört zu einem Seitenpfad? Zwei Quellen, längster
-- Treffer gewinnt:
--   1. prozess_routen (Seiten ohne Beleg-ID, z. B. '/tickets')
--   2. prozess_modelle.routen_muster (':id' steht für ein Pfadsegment)
create or replace function prozess_fuer_pfad(p_pfad text)
returns table (prozess_code text, schritt_code text)
language plpgsql stable as $$
declare
  treffer record;
begin
  if p_pfad is null or p_pfad = '' then return; end if;

  select * into treffer from (
    select r.prozess_code, r.schritt_code, length(r.pfad_muster) as laenge
    from prozess_routen r
    where p_pfad = r.pfad_muster
       or p_pfad like r.pfad_muster || '/%'
       or p_pfad like r.pfad_muster || '?%'
    union all
    select p.code, null, length(m.routen_muster)
    from prozess_modelle m
    join prozesse p on p.modell = m.modell and p.aktiv
    where m.routen_muster is not null
      and p_pfad ~ ('^' || replace(m.routen_muster, ':id', '[^/?]+') || '($|[/?])')
  ) kandidaten
  order by laenge desc
  limit 1;

  if treffer is null then return; end if;
  prozess_code := treffer.prozess_code;
  schritt_code := treffer.schritt_code;
  return next;
end $$;
