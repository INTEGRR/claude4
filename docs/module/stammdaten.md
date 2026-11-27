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
- **Artikelnummern und Barcodes in einer Tabelle** (seit 2026-11-27, `produkte.varianten_codes`): die Variantenliste der Produktseite ist für Schreibberechtigte ein Formular — SKU und EAN aller Varianten, ein Speichern. Geschrieben wird nur Geändertes, ein Tausch zweier Nummern geht in einem Schritt, doppelte Codes werden mit dem Namen der anderen Variante abgelehnt.
- **Hinweis „Anlage unvollständig"** (seit 2026-11-27, `src/modules/shared/anlage-luecken.ts`): Verkaufsprodukte ohne Route, mit Route „Fertigen" ohne Stückliste, mit leerer Stückliste oder mit Varianten ohne Artikelnummer zeigen den Hinweis oben auf der Produktseite; die Shop-Verfügbarkeit listet alle betroffenen Shop-Produkte. Nur Hinweis, keine Sperre.
- **Auswahlfelder mit Serversuche** (seit 2026-11-27): Varianten-, Kunden- und Lieferantenfelder laden 500 Einträge vor und suchen beim Tippen (ab zwei Zeichen) über `GET /api/auswahl` in allen Einträgen — `<Auswahl nachladen="variante|variante-ware|variante-verkauf|variante-einkauf|kunde|lieferant|partner">`.
- **Shop-Regeln am Produkt** (seit 2026-11-27, 0142): Karte „Shop-Verfügbarkeit" an jeder Variante und — bei Material mit genau einer Variante — direkt am Produkt: „Nicht einzeln verkaufen", „Für den Shop sperren", „Ausverkauft unter", bei Shopartikeln zusätzlich Rückhalt, Höchstmenge und die Steuerung des Einzelverkaufs. Dieselbe Aktion wie in Verkauf → Shop-Verfügbarkeit (`verkauf.shop_variante_setzen`); Ändern braucht Schreibrecht im Verkauf.
- **Teil-Kurzanlage** (seit 2026-11-27): „Neues Teil" in Einkauf und Stückliste fragt zusätzlich Einheit, Einstandspreis und Kaufen/Selbst fertigen ab.
- **Querverweise (2026-10-01)**: Lieferantenpreise verlinken den Lieferanten (→ Kontakt), das Bewegungsprotokoll auch Reparaturen. Das **Kontaktformular** zeigt je Partner die letzten Verkaufsaufträge (Status- und Lieferstatus-Schild als Link), Bestellungen, Lieferungen & Transfers (mit Quellbeleg), Reparaturen und Vorgänge — jede Nummer und jedes Schild führt zum Beleg.
- Einstellungen → Stammdaten (nur Admin, seit 2026-09-26): Produktkategorien, Steuern, Zahlungsbedingungen, Tags — alle Schreibwege über die Registry (`einstellungen.kategorie_anlegen`, `…steuer_anlegen`, `…zahlungsbedingung_anlegen`, `…tag_loeschen`); `/produkte/konfiguration` leitet dorthin weiter. Attribute unter Produkte → Attribute; Nummernkreise (nur lesen) unter Einstellungen → Belege & Freigaben; Maßeinheiten und Lagerorte ohne eigene Maske (Migrationen/Datenübernahme). Landkarte: [einstellungen.md](einstellungen.md).

## Abnahmekriterien

1. Produkt „Tastatur" mit Attribut Farbe (3 Werte) erzeugt 3 Varianten mit eigenen SKUs; Bestand und Belege laufen je Variante.
2. Nachträglich ergänzter Attributwert erzeugt die fehlende Variante, bestehende bleiben unangetastet.
3. Einheit „Box (12 Stück)" rechnet im Wareneingang korrekt auf Stück um; Einheiten fremder Kategorien sind nicht wählbar.
4. Variante mit Belegen lässt sich nur deaktivieren, nicht löschen.
