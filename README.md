# ERP — Eigenentwicklung (Odoo-Nachbau)

Eigenes, schlankes ERP-System, das die bei uns aktiv genutzten Odoo-Funktionen nachbaut:

- **Verkauf** — Verkaufsaufträge (v. a. aus Shopify), automatische Erzeugung von Lieferung und Fertigungsauftrag
- **Fertigung** — Produkte mit Varianten, Stücklisten (inkl. „Auf Varianten anwenden"), Fertigungsaufträge (druckbar, mit Barcode), Demontage
- **Einkauf** — Lieferanten, Bestellungen (E-Mail-Versand, Sperren, Stornieren), Wareneingang, Lieferantenrechnungen
- **Lager** — Lagerorte, Lagerbewegungen (Eingang, Ausgang, Fertigung, Storno), Bestände, Inventur, Barcodes
- **Reparatur** — Reparaturaufträge mit Teileverbrauch
- **Integrationen** — Shopify (Order-Import per Webhook, `ready-to-ship`-Tag) und Sendcloud (Versand)

## Dokumente

| Dokument | Inhalt |
|---|---|
| [PLAN.md](PLAN.md) | **Master-Umsetzungsplan** mit Phasen und Abnahmekriterien |
| [docs/architektur.md](docs/architektur.md) | Tech-Stack, Architekturprinzipien, Projektstruktur, Erweiterbarkeit |
| [docs/datenmodell.md](docs/datenmodell.md) | Vollständiges Datenbankschema (Postgres/Supabase) |
| [docs/module/](docs/module/) | Fachliche Spezifikation je Modul |
| [docs/odoo-referenz/](docs/odoo-referenz/) | Recherche-Ergebnisse aus der offiziellen Odoo-18-Dokumentation (Referenzverhalten) |

## Status

Planungsphase — die Umsetzung erfolgt anhand von [PLAN.md](PLAN.md), Phase für Phase.
