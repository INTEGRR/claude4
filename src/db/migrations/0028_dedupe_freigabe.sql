-- ===========================================================================
-- Job-Queue: Dedupe-Schlüssel erledigter Jobs freigeben
-- ===========================================================================
--
-- dedupe_key ist als `unique` angelegt und blieb bisher auch an erledigten
-- Jobs stehen. Für Einmal-Schlüssel („return-label:<id>") ist das egal —
-- für wiederkehrende Schlüssel („inventar-abgleich") ist es fatal: der erste
-- erledigte Job blockiert für immer jeden weiteren. Der Bestandsabgleich wäre
-- genau einmal gelaufen und danach nie wieder, still.
--
-- Gemeint war immer: kein ZWEITER OFFENER Job für denselben Vorgang. Ab
-- jetzt räumt der Runner den Schlüssel beim Abschluss (done wie endgültig
-- failed); hier werden die Altlasten freigegeben.

update integration_jobs set dedupe_key = null where status in ('done', 'failed');

comment on column integration_jobs.dedupe_key is
  'Verhindert doppelte OFFENE Jobs für denselben Vorgang. Wird beim Abschluss '
  'freigegeben (jobs.ts), sonst würde ein wiederkehrender Schlüssel nach dem '
  'ersten Durchlauf für immer blockieren.';
