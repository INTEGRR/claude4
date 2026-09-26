# Go-Live-Plan: Odoo und Sendcloud ablösen

Alles, was vor dem Stichtag eingerichtet, entschieden oder geprüft sein
muss, an einem Ort — damit nichts im Chat liegen bleibt. Der Plan ist eine
Checkliste: abgehakt wird in dieser Datei, im selben Commit wie die
Umsetzung. Die eigentliche Datenübernahme steht im
[Cutover-Runbook](migration-odoo.md#cutover-runbook-stichtag), die
Variablen im Detail in [vercel-supabase.md](vercel-supabase.md); dieser
Plan verweist dorthin, statt es zu wiederholen.

**Wer:** „Betreiber" ist die Person mit Zugang zu Vercel, Supabase, DHL
und Shopify. „KRNL" sind Aufgaben im Code, die vor dem Stichtag fertig
sein müssen.

Stand: 2026-09-18. Erledigt seit Aufstellung: Region Frankfurt,
Sicherheits-Header, Login-Drossel, Cron fail-closed, Tracking über
Parcel DE Tracking, Shopify-Lesemodus als Staging-Schalter
(Entscheidungslog 2026-09-18).

## 1. Geheimnisse und Zugänge (Betreiber, Vercel → Production)

Nichts davon gehört ins Repository. Werte kommen aus den jeweiligen
Portalen; hier stehen nur die Namen und woher sie kommen.

- [ ] `CRON_SECRET` setzen — der Endpunkt antwortet auf Vercel ohne
      Secret mit 401, das heißt: **kein einziger Cron läuft, bis der Wert
      steht** (Outbox, Webhooks, Shopify-Abgleich, Tracking, Aufräumen).
      Vercel schickt ihn bei eigenen Aufrufen automatisch als Bearer mit.
- [ ] `SESSION_SECRET` ist gesetzt und nicht der Wert aus einem Beispiel.
- [ ] **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`): Bot beim
      @BotFather anlegen, Token setzen, dem Bot schreiben, dann unter
      Einstellungen → Benachrichtigungen „Chat-IDs ermitteln" und die ID
      setzen; „Testnachricht senden" muss auf dem Telefon ankommen. Ohne
      die beiden Werte werden Meldungen als „übersprungen" abgehakt.
- [ ] `ZWEIFAKTOR_SCHLUESSEL` setzen (eigener Zufallswert, `openssl rand -hex 32`):
      verschlüsselt die TOTP-Geheimnisse des zweiten Faktors. Fehlt er, nimmt
      KRNL `SESSION_SECRET` — dann darf DER sich nie mehr ändern, sonst
      müssen alle Benutzer die Authenticator-App neu einrichten.
- [ ] **DHL** (alle aus der Produktions-App im DHL Developer Portal bzw.
      dem Geschäftskundenportal, Sandbox-Werte raus):
  - `DHL_API_BASE=https://api-eu.dhl.com`
  - `DHL_API_KEY`, `DHL_API_SECRET` — Key und Secret der Produktions-App
    (die mit Parcel DE Shipping, Returns und Tracking).
  - `DHL_GKP_USER`, `DHL_GKP_PASSWORD` — ein **Systembenutzer** aus dem
    Geschäftskundenportal, nicht das persönliche Login. Passwort läuft
    nach 365 Tagen ab: Erinnerung in den Kalender.
  - `DHL_BILLING_NUMBER` — die 14-stellige Abrechnungsnummer (EKP +
    Verfahren + Teilnahme) für Paket national; weitere Produkte ziehen
    ihre Nummer über die Versandregeln.
  - `DHL_RETURN_RECEIVER_ID` — die Retouren-Empfängerkennung aus dem
    Geschäftskundenportal (Standard `deu`).
  - `DHL_TRACKING_USER`, `DHL_TRACKING_PASSWORD`, `DHL_TRACKING_API`
    bleiben in Produktion **leer** (nur Sandbox bzw. Rückfall).
  - Voraussetzung: „Parcel DE Tracking" in der Produktions-App steht auf
    aktiv, nicht mehr auf pending. Bis dahin meldet der Tracking-Lauf
    einen Anmeldefehler im Ergebnis und sonst nichts.
- [ ] **Shopify**: App im Live-Shop anlegen (Dev Dashboard, Scopes laut
      [lokal-starten.md](lokal-starten.md)), dann `SHOPIFY_SHOP_DOMAIN`,
      `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
      `SHOPIFY_WEBHOOK_SECRET` — siehe
      [api-referenz/shopify.md](api-referenz/shopify.md); Scope
      `read_all_orders`, falls der Backfill weiter als 60 Tage zurück
      soll. **Gefahrlos vor dem Stichtag:** die Anbindung startet im
      Modus „nur lesen" (Staging) — Bestellungen und Produkte kommen
      herein, nichts geht hinaus, bis ein Admin unter Einstellungen →
      Schnittstellen auf „schreiben" stellt
      ([module/integrationen.md](module/integrationen.md)).
- [ ] **Mail**: `RESEND_API_KEY`, `MAIL_FROM` mit verifizierter Domain,
      `REGISTRIERUNG_MAIL`.
- [ ] **KI** (optional): `ANTHROPIC_API_KEY`; `OPENAI_API_KEY` nur, wenn
      das Diktat gebraucht wird.
- [ ] `INSTANZ_REGION="EU-Central · Frankfurt"` für die Anzeige.

## 2. Supabase (Betreiber)

- [ ] Data API abschalten (Project Settings → Data API). Nichts in KRNL
      nutzt PostgREST; Migration 0074 hat die Rechte ohnehin entzogen.
- [ ] „Enforce SSL" einschalten (Database → Settings).
- [ ] Point-in-Time-Recovery buchen — der Rollback-Pfad des Cutovers.
- [ ] Auftragsverarbeitungsvertrag (DPA) im Dashboard abschließen.
- [ ] Bekannt und akzeptiert: btree_gist liegt in public (einzige
      verbleibende Linter-Warnung; Umzug lohnt den Aufwand nicht).

## 3. Vercel (Betreiber)

- [ ] Pro-Tarif — `vercel.json` hat sechs Cron-Einträge, zwei davon
      minütlich; der Hobby-Tarif erlaubt zwei tägliche.
- [ ] Auftragsverarbeitungsvertrag (DPA) abschließen.
- [ ] Entscheidung Deployment Protection: **Vercel Authentication** vor
      die App (Ausnahmen `/api/webhooks/shopify` und `/api/cron`, siehe
      [vercel-supabase.md §6](vercel-supabase.md)) oder bewusst offen
      lassen, weil App-Anmeldung plus Login-Drossel tragen. Empfehlung:
      einschalten, solange /start nicht im eigenen Projekt läuft.
- [ ] Eigene Domain (z. B. erp.<firma>.de) statt `*.vercel.app`, HSTS
      kommt von Vercel mit.
- [x] Region Frankfurt (`regions: ["fra1"]`, verifiziert 2026-09-18).

## 4. Konten (Betreiber)

- [ ] Seed-Konto `admin@example.com` ersetzen: eigenes Admin-Konto
      anlegen, Seed-Konto löschen. Das Passwort des Seed-Kontos wurde am
      26.08.2026 geändert — bestätigen, dass das der Betreiber war.
- [ ] Benutzerkonten je Rolle anlegen (Odoo-Konten werden nicht
      migriert); Rollenmodell in
      [module/rollen-auswertungen-scanner-ki.md](module/rollen-auswertungen-scanner-ki.md).
- [ ] **Zweiter Faktor ist Pflicht für alle** (Standard): jeder Benutzer
      braucht beim ersten Login nach dem Deploy eine Authenticator-App auf
      dem Telefon und richtet sie direkt ein — vorher ankündigen, Backup-
      Codes sichern lassen. Der Admin, der den Deploy macht, richtet als
      Erster ein (Seed-Konto eingeschlossen). Lockern geht unter
      Einstellungen → Sicherheit (`admins` / `freiwillig`).

## 5. Versand fachlich (KRNL + Betreiber)

- [ ] KRNL: Aktion „Adresse prüfen" (Shipping-API `validate=true`) am
      Verkaufsauftrag und am Packtisch — offen, zugesagt.
- [ ] KRNL: Gewichte aus Shopify übernehmen prüfen (Versandgewicht =
      Warengewicht + Kartonage, [module/versand.md](module/versand.md)).
- [ ] Betreiber: Versandregeln und Abrechnungsnummern je Produkt
      (national, Kleinpaket, Europaket, International) hinterlegen.
- [ ] Gemeinsam, erster echter Test mit Produktions-Keys: ein Label für
      eine reale Sendung erstellen, stornieren, im Geschäftskundenportal
      prüfen, dass der Storno ankommt. Danach ein Label, das wirklich
      verschickt wird, und nach ein bis zwei Stunden den Tracking-Lauf
      beobachten (Aktion „Tracking aktualisieren").
- [ ] Ein Retourenlabel erzeugen und die Mail beim Kunden-Testkonto
      prüfen.
- [ ] Reparaturanfrage: Link im Shop und auf der Website auf
      `https://<erp>/service/reparatur` setzen (Link, kein iframe —
      X-Frame-Options DENY); `REPARATUR_MAIL` auf den Service-Posteingang;
      Testanfrage abschicken, im ERP annehmen, Retourenlabel mit RMA-Nummer
      im Geschäftskundenportal sichtbar; Rückversand-Label aus einer
      Reparatur testen. Sendcloud-Retourenportal-Link ersetzen.
- [ ] Druckbrücke am Packtisch-Rechner einrichten
      ([module/versand.md „Druckbrücke"](module/versand.md)); KRNL liefert
      die Schritt-für-Schritt-Anleitung.

## 6. Shopify (im Runbook, Schritt 7)

- [ ] Staging: Produkt-Import gegen Prod im Lesemodus (SKU-Match setzt
      `shopify_variant_id`), Bestellungen per 15-Minuten-Abgleich
      mitlesen und mit Odoo vergleichen.
- [ ] Stichtag: Shopify-Modus auf **schreiben** stellen, dann Webhooks
      registrieren, einmal „Mit Shopify abgleichen" (Bestand), Order-
      Backfill nur ab Stichtag.

## 7. Probelauf und Stichtag

- [ ] Nach dem Deploy einmal `/integrationen` → „Jetzt prüfen": alle
      konfigurierten Dienste grün; danach meldet der Wächter alle fünf
      Minuten nur noch Änderungen (Störung/Entstörung) an Telegram.

- [ ] Probelauf-Choreografie lokal mit **frischem** Odoo-Dump grün,
      inklusive No-Op-Beweis
      ([migration-odoo.md](migration-odoo.md#probelauf-choreografie-lokal-vor-jedem-prod-gedanken)).
- [ ] Stichtag nach dem [Cutover-Runbook](migration-odoo.md#cutover-runbook-stichtag):
      Odoo einfrieren → Dump → PITR-Punkt → Prod leerräumen → Import →
      Abnahme → Shopify → Betrieb.
- [ ] Nach dem Import: `/integrationen` zeigt alle Anbindungen scharf,
      die Cron-Ergebnisse der ersten Stunde durchsehen (Outbox leer,
      Tracking ohne `fehler`).

## 8. Nachlauf

- [ ] Odoo auf lesend/Archiv, Kündigung erst nach Ablauf der
      Aufbewahrungsfrist für Belege klären.
- [ ] Sendcloud erst kündigen, wenn keine Sendcloud-Retourenlabels mehr
      im Umlauf sind (Kunden haben alte Labels noch Wochen später).
- [ ] Erinnerungen: DHL-Systembenutzer-Passwort (365 Tage), Shopify-
      Token-Erneuerung läuft automatisch, Supabase-Backups stichprobenartig
      wiederherstellen.
