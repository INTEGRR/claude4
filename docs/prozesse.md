# Prozessorientiertes ERP — Architektur des Umbaus

Ziel: Das ERP orientiert sich an **Prozessen statt Masken**. Prozesse sind
Daten (designbar, zur Laufzeit je Firma anpassbar), Knöpfe sind registrierte,
API-aufrufbare Aktionen, und jeder gemeldete Fehler wird automatisiert am
Prozess getestet — ohne Knöpfe zu drücken.

Der Umbau läuft in 7 Phasen (Plan beim Betreiber); dieses Dokument hält den
umgesetzten Stand fest.

## Phase 1 — Aktions-Registry (umgesetzt)

**Idee:** Das Muster des KI-Aktionskatalogs (benannte Aktion + zod-Schema +
Bereich + getrennte Ausführung + Torwächter) wird auf alle Server Actions
des Hauses verallgemeinert.

```
src/modules/prozesse/
  registry/typen.ts        RegistrierteAktion: label, bereich, schema,
                           modell, bindung (beleg|frei), uebergang {von[], nach[]},
                           formdata-Adapter, revalidate-Pfade, nurAdmin, prozessfrei
  registry/<modul>.ts      Katalog je Modul (DB-frei, unter Node testbar)
  registry/<modul>-ausfuehren.ts   Fachlogik (SQL) — aus den Alt-Actions umgezogen
  registry/index.ts        REGISTRY (satisfies Record — Vollständigkeit zur Compile-Zeit)
  ausfuehren.ts            AUSFUEHRUNG satisfies Record<AktionsName, Fn>
  torwaechter.ts           aktionPruefen (DB-frei) + aktionErlaubt + aktionAusfuehrenGeprueft
  server-aktion.ts         serverAktion(): Wrapper-Kern für Server Actions
  jobs-katalog.ts          Metadaten der Outbox-Jobs (Fähigkeit statt Anbieter)
  ereignisse.ts            Katalog eingehender Ereignisse (Webhooks, Tracking)
  introspektion.ts         Selbstauskunft für /prozesse und GET /api/aktion
```

- **Ein schreibender HTTP-Endpunkt**: `POST /api/aktion/<name>` (JSON
  `{parameter, record_id}` oder FormData). Antwort im ActionResult-Format;
  400 = fachlich, 403 = Rechte. `GET /api/aktion` liefert das komplette
  Repository. Bestehende Knöpfe bleiben Server Actions — als Dreizeiler um
  `serverAktion()`, denselben Torwächter.
- **Repository-Seite `/prozesse`**: alle registrierten Aktionen (Name, Knopf,
  Bereich, Beleg, Statusübergang, Felder) plus Dienste & Ereignisse.
- **Wächter-Tests** (`tests/prozess-registry.test.ts`): Katalog-Konsistenz,
  Rechte je Rolle, FormData-Adapter, und die statische Abdeckungsanalyse mit
  **schrumpfender Restliste** — eine migrierte Action, die nicht von der
  Liste gestrichen wird, macht die Suite rot.
- Migriert: **fehler** (Tickets) und **lager** (inkl. der
  Warenausgangs-Kette Lose → Buchen → Kartonage → Shopify-Meldung).
  Es folgen: reparatur → produkte/kontakte/personal → verkauf/versand →
  einkauf/fertigung → einstellungen/integrationen.

## Kommende Phasen (Kurzfassung)

2. **Prozessmodell in der DB** (Migration 0036/0037): Prozesse/Versionen/
   Schritte/Übergänge mit jsonb-Bedingungssprache (kein eval); Schritte
   mappen auf die vorhandenen Statusmaschinen — kein doppelter Zustand.
   SVG-Viewer mit „Beleg steht hier".
3. **Prozesstest-Harness + Testdatensatz**: Fixtures je Prozess
   (mitversioniert, Vollständigkeits-Check), Wegwerf-DB lokal, per
   DATABASE_URL gegen Staging; Fake-Adapter für Shopify/DHL/Mail.
4. **Maskengenerierung** aus zod-Schemas (`/p/[prozess]`), Pilot „Artikel anlegen".
5. **Externe Schritte + Bug-Loop + Staging-Automation** (Ticket ↔ Prozesstest ↔ Commit).
6. **Breitenmigration + Laufzeit-Overrides** (Schritte an/aus je Firma).
7. **Chamäleon**: Navigation/KPIs als Projektion aktiver Prozesse,
   Geschäftsmodell-Vorlagen, eigene Felder ohne Migration, generischer
   Vorgang, Fähigkeits-Adapter, KI-Prozessentwurf.
