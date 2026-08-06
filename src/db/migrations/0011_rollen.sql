-- ===========================================================================
-- Rollen: Lager- und Fertigungsmitarbeiter
-- ===========================================================================
-- Nur die Enum-Erweiterung. Neue Werte dürfen nicht in derselben Transaktion
-- verwendet werden, in der sie entstehen — deshalb steht hier sonst nichts.
-- Welche Rolle welche Bereiche sieht, regelt src/modules/auth/permissions.ts.

alter type user_role add value if not exists 'lager';
alter type user_role add value if not exists 'fertigung';
