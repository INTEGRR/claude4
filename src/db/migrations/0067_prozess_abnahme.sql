-- ===========================================================================
-- 0067  Abnahme einer Prozessversion
-- ===========================================================================
-- Die Startseite verspricht: „Ihr schaut aufs Diagramm und sagt, was nicht
-- stimmt. Das ist die Abnahme — kein Lastenheft." Damit ist die Abnahme ein
-- Beleg und keine Bildschirmgeste: wer hat wann welche Version freigegeben.
-- Das Onboarding (Schritt 04 „Zeichnen") schreibt sie, bevor Schritt 05
-- überhaupt schalten darf.
--
-- Bewusst am Entwurf und nicht an der Aktivierung festgemacht: aktiviert
-- wird eine Version vielleicht mehrfach (Rückfall auf eine ältere), abgenommen
-- wird sie einmal.
--
-- Rein additiv.

alter table prozess_versionen
  add column abnahme_am    timestamptz,
  add column abnahme_durch text,
  add column abnahme_notiz text;

comment on column prozess_versionen.abnahme_am is
  'Zeitpunkt der Kundenabnahme des Diagramms (Onboarding Schritt „Zeichnen").';
