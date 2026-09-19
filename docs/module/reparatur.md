# Modul Reparatur

Prozess `reparatur` (Version 2, Migration 0082) und Prozess `reparatur_anfrage`
(Laufzeit-Prozess auf Vorgängen). Referenzverhalten der Werkstatt-Mitte:
[docs/odoo-referenz/lager-reparatur.md](../odoo-referenz/lager-reparatur.md)
(Abschnitt Repairs). Entscheidungslog 2026-09-19.

## Zweck

Reparatur zurückgesandter Tastaturen mit beiden Enden per Post und sauberer
Bestandswirkung: Der Kunde fragt an, bekommt ein DHL-Retourenlabel mit der
RMA-Nummer, das Gerät wird beim Eingang gescannt, verbrauchte Ersatzteile
verlassen das Lager, entnommene Teile werden entsorgt oder wiederverwendet,
und das reparierte Gerät geht per DHL (oder Abholung) zurück. Das
Kundengerät selbst wird **nie** als Bestand gebucht — es gehört dem Kunden.

## Ablauf

1. **Reparaturanfrage** — Vorgang `reparatur_anfrage`, Bereich Reparatur,
   Menüpunkt „Reparaturanfrage" unter Service.
   - Eingang über das öffentliche Formular `/service/reparatur` (Kontakt,
     Adresse, Fehlerbeschreibung, Bestellnummer optional; Quelle
     `kundenformular`) oder intern über „Anfrage erfassen" (Telefon).
   - Der Kunde bekommt eine Eingangsbestätigung mit Vorgangsnummer (Outbox-
     Job `send_repair_request_email`), der Service eine Hinweis-Mail.
   - Schritte: Anfrage erfassen → (Rückfrage beim Kunden, optional) →
     **Annehmen → Reparaturauftrag** oder Ablehnen. Der Reparaturauftrag
     läuft danach als Teilprozess im selben Diagramm (Verkettung über
     `repair_orders.origin_model = 'vorgang'`).
   - **Annehmen** (`reparatur.anfrage_annehmen`): der Mitarbeiter wählt
     Produkt/Variante und Garantie ja/nein. Die Aktion verwendet den Kunden
     per E-Mail wieder (leere Adressfelder werden ergänzt, nie überschrieben)
     oder legt ihn an, erzeugt den Reparaturauftrag mit RMA-Nummer und
     Herkunft und mailt — Schalter `label_senden`, Standard an — sofort das
     Retourenlabel. Scheitert das Label (DHL aus, Adresse unvollständig),
     bleibt der Auftrag in `new`, der Grund steht am Auftrag, und
     „Retourenlabel senden" wird dort erneut angeboten. Ein zweiter Klick
     verlinkt den bestehenden Auftrag (Unique-Index je Anfrage).
2. **Reparaturauftrag** — `repair_orders`, RMA-Nummer, Kunde, Variante,
   Menge, Garantie-Flag, Notiz (aus der Anfrage: Fehlerbeschreibung und
   Bestellnummer), Verantwortlicher, Priorität, Herkunft.
3. **Retourenlabel senden** (optional, `awaiting_device`): DHL Returns
   mit der RMA-Nummer als `customerReference`, Mail mit PDF und QR-Code an
   den Kunden (Text nennt die RMA-Nummer, Zettel-Bitte fürs Paket). Walk-in-
   Kunden überspringen den Schritt.
4. **Gerät eingegangen** (`received`): Scan der Retouren-Sendungsnummer
   oder der RMA-Nummer im Kopf-Scanfeld führt zur Reparaturseite mit
   geöffnetem Formular „Gerät eingegangen"; `received_at` wird gesetzt,
   keine Bestandsbuchung. Erwartete Rücksendungen stehen im Zulauf
   (Karte „Erwartete Reparatur-Rücksendungen": RMA, Kunde, Sendungsnummer,
   Mailstatus). Steht nur die Vorgangsnummer aus der Bestätigungsmail auf
   dem Karton, führt ihr Scan zum Vorgang — von dort zum Auftrag.
5. **Bestätigen** (`confirmed`, aus `new` oder `received`): Teilebewegungen
   entstehen, Einbauteile werden reserviert.
6. **Teile** je Zeile mit Typ — erfassbar ab `new` (Bewegung entsteht erst
   beim Bestätigen; danach sofort, Migration 0038):
   - **add**: Ersatzteile, die eingebaut werden ⇒ Verbrauch aus `WH/Stock`.
   - **remove**: ausgebaute Teile ⇒ Ausschuss-Ort.
   - **recycle**: ausgebaute, wiederverwendbare Teile ⇒ Zugang `WH/Stock`.
7. **Reparatur beginnen / Abschließen** (`under_repair` → `repaired`):
   Abschluss bucht alle Teilebewegungen mit Ist-Mengen.
8. **Kostenpflichtig?** (XOR): bei Garantie nur die Rückgabe; sonst werden
   **Angebot** (Verkaufsauftrag mit den verbauten Teilen) **und** Rückgabe
   angeboten — der Mitarbeiter entscheidet, ob vor der Rückgabe ein Angebot
   nötig ist.
9. **Rückgabe an den Kunden** (`shipped`): DHL-Label aus dem Reparaturauftrag
   (Sendung ohne Lieferung, `shipments.repair_order_id`, Referenz = RMA-
   Nummer, Gewicht aus dem Produkt oder Handeingabe, Zoll bei Drittland als
   `RETURN_OF_GOODS`) mit Sendungsverfolgung über den normalen Tracking-
   Sync — oder `ohne_label` für Abholung/Eigenversand.
10. **Stornieren** (`cancel`) aus `new`, `awaiting_device`, `received`,
    `confirmed`, `under_repair`; nicht nach `repaired`/`shipped`.

## Zustandsmaschine

```
new ──(Retourenlabel)──▶ awaiting_device ──(Scan)──▶ received ──┐
 │                                                              │
 └──────────────(Gerät liegt vor)──────────────────────────────▶ bestätigen
                                                                 │
              confirmed ──▶ under_repair ──▶ repaired ──(Angebot?)──▶ shipped
                                                  │
   cancel  ◀── aus new/awaiting_device/received/confirmed/under_repair
```

Jeder Zustand gehört genau einem Prozessschritt (Belegstatus = einzige
Zustandswahrheit). `repair_confirm` wirft im falschen Status (bis 0081 kehrte
es still zurück). Ein Reparaturauftrag zählt als offen, bis er `shipped`
oder `cancel` ist — auch ein reparierter, noch nicht zurückgegebener.

## Mails

- Eingangsbestätigung der Anfrage (Outbox, `mail:anfrage_bestaetigung`).
- Hinweis an den Service (`REPARATUR_MAIL`, sonst Firmen-E-Mail), best effort.
- Retourenlabel mit RMA-Nummer (Outbox, `mail:retourenlabel`).

## Kennzahlen

`mv_rma_analysis` zählt `repaired` und `shipped` als repariert.

## Abnahmekriterien (= Fixture-Läufe, `npm run test:prozesse`)

1. Reparaturanfrage annehmen: Kunde per E-Mail angelegt bzw. wiederverwendet,
   Reparaturauftrag mit Herkunft in `awaiting_device`, Retourenlabel mit der
   RMA-Nummer als DHL-Referenz, Mail in der Outbox; ohne Label bleibt der
   Auftrag `new`; Ablehnen beendet den Prozess.
2. Per Post, kostenpflichtig: Retourenlabel → Geräteeingang (datiert) →
   Bestätigen → Teile → Abschluss → Angebot → Rückversand (Sendung ohne
   Lieferung, Handgewicht zählt).
3. Garantie: kein Angebot, Rückversand per DHL, Prozess zu Ende.
4. Abholung: Rückgabe ohne Label schließt den Auftrag ohne Sendung.
5. Bestand: Add-Teile werden verbraucht, Remove-Teile liegen im Ausschuss,
   Recycle-Teile erhöhen den Bestand; Storno gibt Reservierungen frei;
   das Kundengerät erzeugt nie eine Bewegung (`tests/reparatur.test.ts`).
