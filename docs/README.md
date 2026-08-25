# Doku-Landkarte

Der Einstieg in die gesamte KRNL-Dokumentation. **Jede Doku-Datei ist hier
verlinkt** — der Doku-Wächter (`tests/doku.test.ts`) macht die Suite rot,
wenn eine Datei fehlt oder ein Link ins Leere zeigt. Die Pflegeregeln
(Entscheidungen loggen, Fachdoku im selben Commit aktualisieren) stehen in
der [AGENTS.md](../AGENTS.md).

## Einstieg

- [lokal-starten.md](lokal-starten.md) — Schritt-für-Schritt lokal
  ausprobieren (Docker oder ohne), Rundgang durch die Beispieldaten.
- [vercel-supabase.md](vercel-supabase.md) — Deployment auf Vercel +
  Supabase, so läuft die Prod-Instanz.
- [website.md](website.md) — die öffentliche Startseite vor dem Login,
  das Registrierungsformular und der einzige Schreibweg ohne Sitzung;
  dazu die Liste offener Platzhalter vor dem Livegang.

## Für Entwickler

- [entwicklung.md](entwicklung.md) — die ersten Handgriffe: einrichten,
  `npm run check`, wie man eine Aktion hinzufügt, wie man eine Migration
  schreibt, wo die aktuelle Fassung einer SQL-Funktion steht, welche Wächter
  es gibt.
- [code-review.md](code-review.md) — Zustand der Codebasis (08/2026):
  was gut ist, was behoben wurde, was zur Entscheidung ansteht.

## Konzepte & Architektur (in dieser Reihenfolge lesen)

- [entscheidungen.md](entscheidungen.md) — **das Entscheidungslog**: jede
  Architektur-, Produkt- und Betriebsentscheidung, datiert, mit Begründung.
  Wer wissen will, WARUM etwas so ist, fängt hier an.
- [architektur.md](architektur.md) — Tech-Stack, Modulschnitt,
  Ledger-Prinzip, Statusmaschinen, Outbox; dazu die Weiterentwicklung seit
  dem Gründungsstand.
- [prozesse.md](prozesse.md) — **die lebendige Systemdoku**: Prozess-ERP
  (Registry, Torwächter, Chamäleon), KI-Integration, Sprachmodus,
  Finanzmodul, Schutzschicht für den Kundenbetrieb. Wächst mit jedem
  Ausbau.
- [datenmodell.md](datenmodell.md) — das Datenmodell der Gründungsphase
  (Notation + Odoo-Statuswerte). Das stets aktuelle Tabelleninventar ist
  `src/modules/ki/schema-doku.ts` — ein Wächter-Test gleicht es gegen die
  echte Datenbank ab. Die zweite Prompt-Wissensquelle der KI ist
  `src/modules/ki/wissen.ts` (Prozess-Best-Practices für Werkstatt und
  Aufnahme, ebenfalls wächter-geprüft) — bewusst im Code versioniert,
  nicht als Doku-Datei.

## Herkunft

- [historie/plan-gruendung.md](historie/plan-gruendung.md) — der
  abgearbeitete Gründungsplan (Arbeitstitel „Odoo-Nachbau"). Historisch, aber
  aufschlussreich: er erklärt, warum die Statuswerte und Buchungsfunktionen
  Odoo-Semantik tragen. Lag bis 08/2026 als PLAN.md im Wurzelverzeichnis und
  wurde dort als aktuelle Anweisung missverstanden.

## Betrieb

- [betrieb.md](betrieb.md) — Deployment-Varianten (Docker, VPN, Vercel),
  Netzwerk, Secrets. Backup/PITR und Update-Ringe: siehe „Schutzschicht"
  in [prozesse.md](prozesse.md).
- [migration-odoo.md](migration-odoo.md) — die Datenübernahme aus Odoo 18
  (ANVIL): Architektur des Importers, Phasen, Verzichtsliste,
  Cutover-Runbook.

## Module (Fachdoku der Gründungsphase, je Bereich)

- [module/verkauf.md](module/verkauf.md) — Verkaufsaufträge, Shopify-Import,
  Lieferung.
- [module/einkauf.md](module/einkauf.md) — Bestellungen, Wareneingang,
  Rechnungen mit 3-Wege-Abgleich.
- [module/lager.md](module/lager.md) — Bewegungs-Ledger, Transfers,
  Inventur, Meldebestände.
- [module/fertigung.md](module/fertigung.md) — Stücklisten, Varianten,
  Fertigungsaufträge, Arbeitsplätze.
- [module/versand.md](module/versand.md) — DHL, Versandregeln, Kartonagen,
  Massendruck.
- [module/reparatur.md](module/reparatur.md) — Reparaturaufträge mit
  Teileverbrauch.
- [module/personal.md](module/personal.md) — Mitarbeiter, Zeiterfassung,
  Schichten, Abwesenheiten.
- [module/stammdaten.md](module/stammdaten.md) — Produkte, Kategorien,
  Steuern, Zahlungsbedingungen, Kontakte.
- [module/integrationen.md](module/integrationen.md) — Shopify-Sync,
  Webhooks, Outbox, Ereignis-Monitor.
- [module/kennzahlen.md](module/kennzahlen.md) — Auswertungen und
  Kennzahlen-Definitionen.
- [module/rollen-auswertungen-scanner-ki.md](module/rollen-auswertungen-scanner-ki.md)
  — Rollen, Scanner-Arbeitsplatz, KI-Analyse (Chat).
- [module/odoo-vervollstaendigung.md](module/odoo-vervollstaendigung.md) —
  Abgleichliste: welche Odoo-Funktionen nachgebaut sind.

Finanzen und Sprachmodus sind nach der Gründungsphase entstanden und in
[prozesse.md](prozesse.md) dokumentiert (Abschnitte Finanzen/Sprachmodus).

## API-Referenzen (extern)

- [api-referenz/shopify.md](api-referenz/shopify.md) — Shopify Admin API
  (GraphQL), Webhooks, Eigenheiten der Version 2026-07.
- [api-referenz/dhl.md](api-referenz/dhl.md) — DHL Parcel DE Shipping API v2.
- [api-referenz/sendcloud-shopify-funktionsumfang.md](api-referenz/sendcloud-shopify-funktionsumfang.md)
  — historisch: Sendcloud-Funktionsumfang von vor der DHL-Entscheidung
  (siehe Entscheidungslog 2026-08-05).

## Odoo-Referenz (historisch, Gründungsreferenz)

Die Odoo-18-Semantik, die nachgebaut wurde — Statuswerte und Abläufe als
Vergleichsbasis, kein Betriebswissen:

- [odoo-referenz/verkauf.md](odoo-referenz/verkauf.md)
- [odoo-referenz/einkauf.md](odoo-referenz/einkauf.md)
- [odoo-referenz/fertigung.md](odoo-referenz/fertigung.md)
- [odoo-referenz/lager-reparatur.md](odoo-referenz/lager-reparatur.md)
