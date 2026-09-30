-- ============================================================================
-- 0095  Navigation je Benutzer
-- ----------------------------------------------------------------------------
-- Die Gruppen der linken Navigation (Verkauf, Einkauf, Lager …) sind ab jetzt
-- standardmäßig eingeklappt; welche jemand geöffnet hat, merkt sich KRNL am
-- Benutzer statt im Browser — derselbe Zustand an jedem Gerät. Leer = alles
-- zu. Entscheidungslog 2026-09-30.
-- ============================================================================

alter table users add column nav_offen text[] not null default '{}';

comment on column users.nav_offen is
  'Geöffnete Gruppen der linken Navigation (Beschriftungen, 0095) — leer = alles eingeklappt';
