# Modul Stammdaten

Referenzverhalten: [docs/odoo-referenz/fertigung.md](../odoo-referenz/fertigung.md) (Abschnitt 6, Produkte & Varianten) und [docs/odoo-referenz/lager-reparatur.md](../odoo-referenz/lager-reparatur.md) (Abschnitt 7, Maßeinheiten)

## Produkte & Varianten (Odoo-Modell)

- **Produktvorlage** (`product_templates`): Name, Typ (Ware/Dienstleistung), Verkaufs-/Einkaufspreis, Maßeinheiten, Abrechnungs-/Beschaffungsrichtlinien, Routen-Flags (**MTO**, **Fertigen**, **Einkaufen**), Verkauf-/Einkauf-Checkboxen.
- **Attribute** (`product_attributes` + Werte): z. B. `Farbe` (Weiß, Schwarz, Blau), `Switch`, `Layout`. Anzeigetyp (Auswahl/Farbe/…), optional Aufpreis je Wert (`price_extra`).
- **Varianten** (`product_variants`): entstehen beim Speichern der Attributzuordnung als kartesisches Produkt (Odoo-Modus „Sofort"; „Dynamisch/Nie" = Erweiterung). Jede Variante hat eigene **SKU** (= Shopify-SKU, Mapping-Schlüssel!), eigenen **Barcode**, eigenen Bestand. Produkte ohne Attribute bekommen automatisch genau eine Variante — alle Belege und Bestände referenzieren ausschließlich Varianten.
- Deaktivieren statt Löschen, sobald ein Beleg die Variante referenziert.

## Maßeinheiten

Kategorien mit Referenzeinheit und Faktor (`ratio`); Umrechnung **nur innerhalb einer Kategorie** (Odoo-Regel). Seed: Kategorie „Einheit" (Stück als Referenz), „Gewicht" (g/kg), „Länge" (mm/m). Produkt: getrennte Lager-/Verkaufs- und Einkaufseinheit; automatische Umrechnung bei Wareneingang.

## Kontakte

Eine Tabelle `partners` für Kunden **und** Lieferanten (Flags), wie Odoos `res.partner`: Name, Firma/Person, Adresse, E-Mail, Telefon, USt-ID, Zahlungsziel, Shopify-Kunden-ID (für Import-Upsert).

## UI

- Produktliste (Suche über Name/SKU/Barcode, Filter Varianten/aktiv), Produktformular mit Reitern **Allgemein**, **Attribute & Varianten** (Zuordnung + generierte Variantenliste mit SKU/Barcode/Bestand), **Einkauf** (Lieferantenpreise, Richtlinie), **Lager** (Routen, Einheiten).
- Variantenformular: SKU, Barcode, Shopify-Zuordnung, Bestandsübersicht, Bewegungsprotokoll, Etikettendruck.
- Einstellungen → Stammdaten (nur Admin, seit 2026-09-26): Produktkategorien, Steuern, Zahlungsbedingungen, Tags — alle Schreibwege über die Registry (`einstellungen.kategorie_anlegen`, `…steuer_anlegen`, `…zahlungsbedingung_anlegen`, `…tag_loeschen`); `/produkte/konfiguration` leitet dorthin weiter. Attribute unter Produkte → Attribute; Nummernkreise (nur lesen) unter Einstellungen → Belege & Freigaben; Maßeinheiten und Lagerorte ohne eigene Maske (Migrationen/Datenübernahme). Landkarte: [einstellungen.md](einstellungen.md).

## Abnahmekriterien

1. Produkt „Tastatur" mit Attribut Farbe (3 Werte) erzeugt 3 Varianten mit eigenen SKUs; Bestand und Belege laufen je Variante.
2. Nachträglich ergänzter Attributwert erzeugt die fehlende Variante, bestehende bleiben unangetastet.
3. Einheit „Box (12 Stück)" rechnet im Wareneingang korrekt auf Stück um; Einheiten fremder Kategorien sind nicht wählbar.
4. Variante mit Belegen lässt sich nur deaktivieren, nicht löschen.
