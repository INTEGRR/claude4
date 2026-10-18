# Modul: Retouren (Migration 0119, seit 2026-10-17)

## Zweck

Ein Shop-Kunde will gelieferte Ware nicht behalten. KRNL führt die
Rücksendung als Prozess nach dem Muster der Reparatur: Anfrage, Genehmigung
mit DHL-Retourenlabel, Eingang per Scan, Prüfung je Position mit
Rückbuchung, Abschluss. **Erstattet wird im Shopify-Admin** — KRNL erkennt
die Erstattung am Bestell-Webhook und schließt die Retoure dann selbst ab.
Ein verkaufsfähiger Rückläufer ist sofort wieder verkaufbar; Fertigung, die
er überflüssig macht, entfällt, und das Team Fertigung bekommt Bescheid.

Nur Shop-Aufträge (`sales_orders.source = 'shopify'`). Entscheidungen des
Betreibers: [Entscheidungslog 2026-10-17](../entscheidungen.md).

## Ablauf (Prozess `retoure`, Bereich Versand)

1. **Anfrage** (`angefragt`) — im Shop über das Retourenportal
   (`/apps/reparatur/retoure`, siehe [website.md](../website.md) „Im Shop
   (App Proxy)") oder intern über Versand → Retouren → „Retoure anlegen"
   bzw. den Knopf am gelieferten Shop-Auftrag (`versand.retoure_anlegen`).
   Je Auftragszeile höchstens die gelieferte Menge abzüglich offener oder
   erledigter Retouren — seit 0125 auch, wenn dieselbe Zeile im selben
   Aufruf mehrfach kommt; Grund aus einer festen Liste
   (`modules/versand/retoure-gruende.ts`), Anliegen als Freitext. Das Portal
   schickt eine Eingangsbestätigung (Outbox-Job `send_return_request_email`).
   Fehlversuche der Suche sind je E-Mail, Bestellnummer und Shop-Kunde
   gedrosselt (10 je Stunde, `portal_suchversuche`, 0131) — damit lassen
   sich zu einer bekannten Adresse keine Bestellnummern durchprobieren.
   Gespeichert wird der Shop-Gesamtbetrag zum Zeitpunkt der Anfrage
   (`shop_brutto_vorher`) — die Vergleichsbasis der Erstattung.
2. **Genehmigen** (`genehmigt`, `versand.retoure_genehmigen`) — mit
   Schalter „Retourenlabel sofort mailen" (Standard an): DHL-Retourenlabel
   mit der Retourennummer `RT/…` als Referenz, Absender die **Lieferadresse
   der Bestellung**, Mail an die Adresse der Anfrage bzw. der Bestellung.
   Scheitert das Label, bleibt die Retoure genehmigt, der Grund steht im
   Verlauf und als letzter Fehler auf der Labelkarte (beim Genehmigen wie
   beim erneuten Senden) und „Retourenlabel senden" wird dort angeboten
   (`versand.retoure_label_senden`). Oder **Ablehnen** (`abgelehnt`) mit
   Begründung, auf Wunsch per Mail (`send_return_rejected_email`).
3. **Ware eingegangen** (`eingegangen`, `versand.retoure_eingang`) — Scan
   der Retouren-Sendungsnummer oder der Retourennummer im Kopf-Scanfeld
   öffnet die Retoure mit „Ware eingegangen". Genehmigte Retouren stehen im
   Zulauf (Karte „Erwartete Kunden-Retouren"). Kommt ein Paket ohne
   Genehmigung, geht der Eingang auch aus `angefragt`. Noch keine Buchung.
4. **Prüfen und zurückbuchen** (`geprueft`, `versand.retoure_pruefen`, Karte
   „Positionen" auf der Retoure) — Ergebnis je Position:
   - **verkaufsfähig** → Rück-Transfer `Partner/Kunden → WH/Stock`: sofort
     wieder verkaufbar (freier Bestand, Shop-Menge), wartende Lieferungen
     desselben Artikels werden gleich reserviert (Live-Reservierung, hier
     ausdrücklich in derselben Transaktion).
   - **B-Ware** / **defekt** → `WH/B-Ware`. Nur markiert: der Ort hat den Typ
     `inventory_loss`, zählt also weder im freien Bestand noch für Shopify
     noch in der Reservierung. Keine Demontage, keine Weiterverarbeitung.
   Der Rück-Transfer trägt die Vorgangsart Wareneingang, die Herkunft
   `retoure` und den Rückbezug auf die Lieferung (`return_of_id`).
5. **Im Shop erstattet** (Ereignis `shop:bestellung_erstattet`) — der
   Bestell-Webhook (`orders/updated`, auch der volle Storno) erkennt die
   Erstattung: Shop meldet „ganz erstattet" oder der Gesamtbetrag
   (`currentTotalPriceSet`) liegt unter `shop_brutto_vorher`. Die Retoure
   bekommt `erstattet_am`; ist sie geprüft, schließt sie sofort ab. Kommt
   die Erstattung vor der Prüfung, schließt die Prüfung ab.
6. **Abschließen** (`abgeschlossen`, `retoure_abschliessen`) — von selbst
   nach der Erstattung, oder von Hand mit der Bestätigung „im Shop
   erstattet" (`versand.retoure_abschliessen`). Für jede verkaufsfähig
   zurückgebuchte Variante entfallen nicht begonnene Fertigungsaufträge
   (Entwurf/bestätigt, nichts gefertigt), deren Auftrag die offene Lieferung
   dieser Variante jetzt vollständig reserviert hat — höchstens so viel, wie
   zurückkam, ältester Termin zuerst. Das Team Fertigung bekommt eine
   Aufgabe „Retoure RT/…: Fertigung anpassen"; schon begonnene Fertigung
   bleibt und steht als „bitte prüfen" in der Aufgabe. Was geschah, steht in
   `fertigung_info` am Beleg.
7. **Stornieren** (`storniert`) — der Kunde zieht zurück, bevor Ware da ist.

Wartet keine Lieferung auf den Rückläufer, liegt er frei im Lager — und die
**nächste Bestellung** wird ohne Fertigung bedient: `confirm_sales_order`
rechnet seit 0119 verkaufsfähige, noch nicht wiederverwendete Rückläufer
(`retoure_positionen.wiederverwendet`, Funktion `ruecklaeufer_frei`) gegen die
Made-to-Order-Menge, gefertigt wird nur der Rest (Notiz am Auftrag).
Gewöhnlicher Fertigbestand ersetzt keine Fertigung — die bestehende Regel
„MTO fertigt auftragsbezogen" bleibt. Siehe [fertigung.md](fertigung.md).

## Zustandsmaschine

```
angefragt ──▶ genehmigt ──▶ eingegangen ──▶ geprueft ──(Shop erstattet)──▶ abgeschlossen
   │  │            │              ▲                │
   │  └────────────┼──────────────┘ (ohne Genehmigung eingetroffen)
   │               │                               └──(von Hand bestätigt)──▶ abgeschlossen
   ├──▶ abgelehnt  │
   └──▶ storniert ◀┘
```

Jeder Zustand gehört genau einem Prozessschritt (Belegstatus = einzige
Zustandswahrheit); die Erstattung ist ein Ereignis mit Zeitstempel, kein
eigener Zustand.

## Oberfläche

- **Versand → Retouren** (`/versand/retouren`): Liste mit Filtern (offen,
  zu entscheiden, zu prüfen, warten auf Erstattung, alle), Zähler im Menü =
  Retouren zum Entscheiden oder Prüfen. Darunter wie bisher das
  Retourenlabel ohne Retoure und alle Labels (Spalte „Zu": Reparatur oder
  Retoure).
- **Retoure** (`/versand/retouren/[id]`): Anfrage, Verlauf mit Zeitpunkten,
  Positionen bzw. Prüfmaske, Retourenlabel, Prozess-Panel, Kommentare.
- **Verkaufsauftrag**: Knopf „Retoure anlegen" bei gelieferten
  Shop-Aufträgen, solange noch etwas rücksendbar ist
  (`retoure_restmenge(auftrag)` > 0, seit 0125); der Shop-Storno nach Lieferung meldet keinen Fehler mehr,
  wenn eine Retoure existiert.

## Datenmodell

`retouren` (Nummernkreis `retoure`, Präfix `RT/`), `retoure_positionen`,
`return_labels.retoure_id`, Lagerort `WH/B-Ware` (Barcode `LOC-WH-BWARE`).
Funktionen `retoure_anlegen`, `retoure_genehmigen`, `retoure_ablehnen`,
`retoure_eingang`, `retoure_pruefen`, `retoure_erstattet`,
`retoure_abschliessen`, `retoure_stornieren`. Das aktuelle Inventar steht in
`src/modules/ki/schema-doku.ts`.

## Grenzen

- Sind zu einer Bestellung mehrere Retouren gleichzeitig offen, gilt eine
  Erstattung für alle (selten; die Fertigung wird je Retoure nur im Umfang
  ihrer verkaufsfähigen Menge angepasst).
- Die Erstattungshöhe prüft KRNL nicht gegen die Positionen — das bleibt
  im Shop. Die Rechnungsseite folgt ohnehin der Shop-Erstattung
  (Gutschrift über die zurückgenommene Menge, 0115).
- Retourenlabels selbst werden nicht verfolgt (wie bei der Reparatur).

## Abnahmekriterien (= Fixture-Läufe und Prozesstest)

- Fixture `retoure`: Board zurück → genehmigt mit Label → Eingang →
  verkaufsfähig geprüft → Shop erstattet (Webhook, voller Storno) →
  abgeschlossen, Fertigung des nächsten Auftrags entfällt, seine Lieferung
  ist aus dem Rückläufer reserviert, Aufgabe fürs Team Fertigung; B-Ware nach
  `WH/B-Ware` ohne Wirkung auf den freien Bestand, Abschluss von Hand;
  Ablehnung mit Mail.
- `tests/prozesse/retouren.test.ts`: nur Shop-Aufträge und nur Geliefertes,
  Portal (Nummer + E-Mail, angemeldeter Kunde, Honigtopf, Mengen,
  Eingangsbestätigung), Erstattung vor der Prüfung, Gegenrechnung bei der
  nächsten Bestellung.
