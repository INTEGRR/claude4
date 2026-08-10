# Bereitstellung auf Vercel mit Supabase

Schritt für Schritt von einem leeren Vercel-Konto zu einer laufenden Instanz.
Rechnen Sie mit zehn Minuten. Das entspricht [Variante B](betrieb.md) —
gehostet, Oberfläche hinter Zugangsschutz.

Der Code ist dafür vorbereitet: `output: standalone` entfällt auf Vercel
automatisch, Labels liegen in der Datenbank statt im Dateisystem (Migration
0025), und der Build spielt Schema und Grunddaten selbst ein.

---

## 1. Datenbank bei Supabase anlegen

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Name frei wählen (z. B. `anvil-erp`), Region **Central EU (Frankfurt)** —
   kurze Wege zur Anwendung und Daten bleiben in der EU.
3. Datenbank-Passwort erzeugen lassen und **sofort sichern**; Supabase zeigt es
   nur einmal.

Ein zusätzliches Projekt kostet je nach Tarif der Organisation Geld
(Stand heute: 10 $ pro Monat, wenn im Tarif kein Projekt mehr frei ist).
Alternativ lässt sich eine bestehende Instanz mitbenutzen — dann ein eigenes
Schema anlegen, damit sich die Tabellen nicht mit anderen Projekten mischen.

### Die beiden Verbindungszeichenfolgen

Unter **Project Settings → Database → Connection string** stehen mehrere
Varianten. Die Anwendung braucht **zwei davon**, und zwar aus einem Grund:

| Variable | Welche Verbindung | Wofür |
|---|---|---|
| `DATABASE_URL` | **Transaction pooler**, Port `6543` | Die laufende Anwendung. Jeder Aufruf einer Serverless-Funktion nimmt kurz eine Verbindung und gibt sie zurück — nur so überlebt die Datenbank viele gleichzeitige Aufrufe. |
| `DIRECT_URL` | **Session pooler**, Port `5432` | Migration und Grunddaten beim Build. Schemaänderungen brauchen eine echte Sitzung; der Transaction pooler kann jede Anweisung auf eine andere Verbindung legen. |

Im Docker-Betrieb und lokal ist beides dieselbe Adresse — dort bleibt
`DIRECT_URL` einfach leer.

---

## 2. Projekt auf Vercel anlegen

1. [vercel.com/new](https://vercel.com/new) → dieses Git-Repository auswählen.
2. Framework wird als **Next.js** erkannt, Build-Command und Output-Verzeichnis
   unverändert lassen. Vercel nimmt automatisch das Skript `vercel-build` aus
   der `package.json` — das spielt Migrationen und Grunddaten ein und baut
   danach.
3. **Noch nicht bereitstellen.** Erst die Umgebungsvariablen eintragen.

---

## 3. Umgebungsvariablen setzen

Unter **Settings → Environment Variables**, jeweils für *Production* (und für
*Preview*, wenn Vorschau-Bereitstellungen dieselbe Datenbank nutzen sollen —
Vorsicht, sie schreiben dann in dieselben Daten).

**Pflicht:**

```
DATABASE_URL     postgres://postgres.<ref>:<passwort>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres
DIRECT_URL       postgres://postgres.<ref>:<passwort>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
SESSION_SECRET   <32 Byte Zufall, z. B. `openssl rand -hex 32`>
```

Ohne `SESSION_SECRET` lässt sich niemand anmelden. Der Wert darf sich später
ändern — dann sind alle offenen Sitzungen ungültig, mehr passiert nicht.

**Empfohlen:**

```
CRON_SECRET      <24 Byte Zufall>
```

Schützt `/api/cron/*` vor fremden Aufrufen. Vercel sendet ihn bei den eigenen
Cron-Aufrufen automatisch als `Authorization: Bearer …` mit. Ist er nicht
gesetzt, ist der Endpunkt offen — er löst nur Hintergrundarbeit aus und gibt
keine Daten heraus, aber ohne Not sollte das niemand so lassen.

**Optional, je nach Anbindung** (leer lassen heißt: Modul ist aus):

```
ANTHROPIC_API_KEY        schaltet die Seite /ki frei
SHOPIFY_SHOP_DOMAIN      meinshop.myshopify.com
SHOPIFY_CLIENT_ID        Dev-Dashboard-App, Settings → Credentials
SHOPIFY_CLIENT_SECRET    dito — Token holt und erneuert das ERP selbst
SHOPIFY_ADMIN_TOKEN      nur Alt-Apps von vor 2026 (statisches shpat_…)
DHL_API_KEY              …und die übrigen DHL_-Variablen aus .env.example
RESEND_API_KEY           Mailversand an Lieferanten
MAIL_FROM                "Einkauf <einkauf@example.com>"
```

Die Startseite `/integrationen` zeigt später, welche Anbindungen scharf sind.

---

## 4. Bereitstellen

**Deploy** drücken. Im Build-Protokoll sollte stehen:

```
→ scripts/migrate.ts
  ✓ 0001_fundament.sql
  …
  ✓ 0031_demodaten.sql
→ scripts/seed.ts
```

Der Build legt **nur den Administrator** an — Beispieldaten spielt er
grundsätzlich nicht ein (wer sie zum Ausprobieren will, führt
`npm run db:seed -- --demo` bewusst von Hand gegen die Datenbank aus).
Danach ist die Anwendung erreichbar. Anmeldung:

| | |
|---|---|
| E-Mail | `admin@example.com` |
| Passwort | `erp-admin` |

**Dieses Passwort sofort ändern** (Einstellungen → Benutzer verwalten). Wer es
gar nicht erst anlegen will, setzt vor der ersten Bereitstellung
`SEED_ADMIN_EMAIL` und `SEED_ADMIN_PASSWORD`.

**Falls mit Beispieldaten getestet wurde:** Einstellungen → „Gefahrenzone:
alle Daten löschen (Neustart)" entfernt vor dem echten Betrieb sämtliche
Belege, Produkte, Partner, Bestände und Protokolle samt der beiden
Demo-Konten; Benutzer, Firmendaten, Lagerorte und Konfiguration bleiben,
Belegnummern starten wieder bei 1. Danach holt die Shopify-Erstübernahme
(Seite „Integrationen") Produkte, Kunden und Bestellungen aus dem Shop.

---

## 5. Zeitgesteuerte Aufgaben

`vercel.json` bringt fünf Cron-Einträge mit — Outbox, Webhooks, Abgleich,
Sendungsverfolgung, Aufräumen.

**Der Hobby-Tarif erlaubt nur zwei Cron-Jobs, und die laufen einmal täglich.**
Das reicht für einen Testbetrieb, aber nicht für den Versandalltag: Fulfillment
und Sendungsverfolgung hängen dann bis zum nächsten Tag fest. Zwei Wege:

- **Pro-Tarif** — die fünf Einträge laufen wie hinterlegt.
- **Hobby** — `vercel.json` auf zwei tägliche Einträge kürzen und die
  minütlichen Aufgaben von außen anstoßen, etwa per GitHub Action oder von
  einem beliebigen Rechner, der ohnehin läuft:

  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
       https://<projekt>.vercel.app/api/cron?task=jobs
  ```

---

## 6. Oberfläche schützen

Das ERP enthält Kunden- und Lieferantendaten und gehört nicht ins offene Netz.
Unter **Settings → Deployment Protection** *Vercel Authentication* einschalten.

Zwei Pfade müssen davon ausgenommen bleiben, sonst funktionieren Shopify und
Cron nicht mehr:

- `/api/webhooks/shopify` — prüft die HMAC-Signatur selbst und weist alles ohne
  gültige Signatur mit 401 ab.
- `/api/cron/*` — abgesichert über `CRON_SECRET`.

---

## Was auf Vercel anders ist als im Docker-Betrieb

| | Docker | Vercel |
|---|---|---|
| Label-PDFs | zusätzlich als Datei unter `STORAGE_DIR` | ausschließlich in der Datenbank (`shipments.label_pdf`) |
| Migrationen | beim Containerstart (`entrypoint.sh`) | beim Build (`vercel-build`) |
| Zeitsteuerung | Cron auf dem Host | Vercel Cron, Tarifgrenzen beachten |
| Datenbank | im Compose-Netz, nicht von außen erreichbar | Supabase, Verbindung über den Pooler |

Der Code ist derselbe; es gibt keinen Vercel-Zweig in der Anwendung.

---

## Wenn der Build scheitert

**`Keine DATABASE_URL gesetzt — Migration und Grunddaten werden übersprungen.`**
Der Build läuft absichtlich durch, die Anwendung wird aber auf jeder Seite
scheitern. Variablen nachtragen und neu bauen.

**`Migration <datei> wurde nach dem Einspielen geändert.`**
Eine bereits eingespielte Migration wurde nachträglich bearbeitet. Migrationen
sind unveränderlich — die Änderung gehört in eine neue Datei.

**Zeitüberschreitung beim Verbinden.**
Fast immer die falsche Portnummer: `DIRECT_URL` muss auf `5432` zeigen,
`DATABASE_URL` auf `6543`.
