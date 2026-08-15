-- Tickets: Verknüpfung zur Quelle der Behebung.
--
-- Wenn die Entwicklung eine Meldung schließt, trägt sie neben dem Vermerk
-- (aufloesung) den Commit ein, der den Fehler behebt — die Ticketliste
-- verlinkt ihn direkt ins GitHub-Repository. So führt jede geschlossene
-- Meldung zur tatsächlichen Änderung statt zu einem "wurde behoben".

alter table bug_reports add column commit_sha text;

comment on column bug_reports.commit_sha is
  'Commit, der die Meldung behebt (voller oder gekürzter SHA); wird in der '
  'Oberfläche ins Repository verlinkt.';
