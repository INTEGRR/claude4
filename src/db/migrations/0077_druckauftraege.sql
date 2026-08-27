-- ===========================================================================
-- 0077  Druckaufträge: die Warteschlange der Druckbrücke
-- ===========================================================================
-- Die Vercel-App erreicht den Labeldrucker am Packtisch nie direkt — ein
-- kleiner Agent auf dem Packtisch-PC (scripts/druck-agent.ts) holt sich
-- offene Aufträge per HTTPS ab (Pull-Modell), druckt still und quittiert.
-- versand.packtisch_abschliessen reiht hier ein, sobald DRUCK_AGENT_TOKEN
-- gesetzt ist; ohne Token bleibt der Tab-Fallback (Label öffnet sich im
-- Browser). Entscheidungslog-Eintrag folgt mit dem Packtisch-Abschluss.

create table druckauftraege (
  id          uuid primary key default gen_random_uuid(),
  art         text not null default 'label' check (art in ('label')),
  shipment_id uuid not null references shipments(id) on delete cascade,
  status      text not null default 'offen' check (status in ('offen', 'gedruckt', 'fehler')),
  fehler      text,
  created_at  timestamptz not null default now(),
  gedruckt_am timestamptz
);

-- Der Agent fragt immer „älteste offene zuerst".
create index druckauftraege_offen_idx on druckauftraege (created_at) where status = 'offen';

comment on table druckauftraege is
  'Warteschlange der Druckbrücke: der Agent am Packtisch-PC holt offene Aufträge ab, druckt und quittiert.';
