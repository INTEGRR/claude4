# Lasttest „Shopify-Ausverkauf"

Fährt die **echte App** gegen einen **eigenständigen Shop-Nachbau** und eine
**Wegwerf-Datenbank**: hunderte Käufe in Sekunden auf Angebote, die sich
ihre Teile teilen. Nichts davon berührt die Produktion oder den echten Shop.

Hintergrund und Ergebnisse: [docs/release-neue-produkte.md](../docs/release-neue-produkte.md),
Verfahren: [docs/module/integrationen.md](../docs/module/integrationen.md)
(„Kontingent und Buch").

## Was hier liegt

| Datei | Zweck |
|---|---|
| `shop-nachbau.mjs` | Eigenes Programm, **nicht Teil der App**. Verhält sich an der Admin-API wie Shopify: führt je Angebot einen Bestand, zählt bei jedem Kauf sofort herunter, nimmt absolute Meldungen und Differenzen an (Vergleichswert, Idempotenz-Schlüssel), drosselt und schickt signierte Webhooks — verzögert, doppelt, in vertauschter Reihenfolge. Rechnet bei jedem Kauf und jeder Meldung nach, ob das Angebotene durch Teile gedeckt ist. |
| `lauf.ts` | Legt das Sortiment an (32 Tastaturen aus 2 Gehäusen × 2 Plates × 4 Switches × 2 Keycap-Sets, dazu eine einzeln verkaufte Plate), feuert die Käufe ab, wartet auf die Verarbeitung und schreibt den Bericht nach `ergebnis/`. |

## Aufruf

```bash
# 1. Wegwerf-Datenbank (der Name MUSS „lasttest" enthalten — sonst bricht lauf.ts ab)
createdb erp_lasttest
export DATABASE_URL=postgres://…/erp_lasttest
npm run db:migrate && npm run db:seed

# 2. App bauen und gegen den Nachbau starten
export SESSION_SECRET=… KI_FAKE=1 \
  SHOPIFY_SHOP_DOMAIN=nachbau.local SHOPIFY_ADMIN_TOKEN=lasttest \
  SHOPIFY_API_BASE=http://127.0.0.1:4010 SHOPIFY_WEBHOOK_SECRET=lasttest-geheim
npx next build && npx next start -p 3100 &

# 3. Shop-Nachbau
NACHBAU_APP=http://127.0.0.1:3100 NACHBAU_SECRET=lasttest-geheim node lasttest/shop-nachbau.mjs &

# 4. Lauf
node --experimental-strip-types lasttest/lauf.ts --kaeufe 300 --sekunden 20
```

Schalter: `--kaeufe N`, `--sekunden S` (Dauer des Ansturms), `--cron S`
(Takt der Cron-Aufrufe, Standard 20 s), `--chaos` (Webhooks bis 4 s
verzögert, 30 % doppelt, 15 % bis 15 s verspätet, halbes Abruf-Kontingent),
`--heilen` (wartet nach dem Lauf auf ruhige Zeit und gleicht noch einmal ab).

Meldemodus: ohne Schalter „aufgeteilt" (Kontingent). Mit `--modus fest`
läuft die feste Menge mit Schnellstopp; dazu `--puffer N` (Schwelle in
Stück je Teil, Standard 2) und `--deckel N` (die feste Menge, Standard 999).
`--verzug von,bis` setzt, wie viele Millisekunden nach dem Kauf der Nachbau
die Bestellung meldet — in der Produktion gemessen: `2200,3500`.

```bash
node --experimental-strip-types lasttest/lauf.ts --modus fest --puffer 2 --verzug 2200,3500 --kaeufe 240 --sekunden 120
```

`SHOPIFY_API_BASE` lenkt die Admin-API der App auf den Nachbau um. Die
Variable gibt es nur für diesen Test; in Produktion ist sie nicht gesetzt.

## Was der Bericht prüft

- **Teile überverkauft** — hat der Shop mehr verkauft, als Teile da waren?
- **Augenblicke ohne Deckung** — bot der Shop irgendwann mehr an, als Teile
  da waren (auch wenn es niemand gekauft hat)? Gilt nur „aufgeteilt": die
  feste Menge bietet mit Absicht voll an, dort zählt allein der Überverkauf.
- **Stopp je Teil** — vom Kauf, der ein Teil auf die Schwelle brachte, bis
  alle Angebote mit diesem Teil auf 0 standen, und wie viele Käufe mit dem
  Teil in dieser Zeit noch durchgingen.
- **Bestellungen angekommen und voll reserviert** — jede angenommene
  Bestellung steht in KRNL, mit Fertigungsauftrag und reservierten Teilen.
- **Shop gegen Kontingent am Ende** — mehr wäre ein Fehler, weniger ist die
  sichere Seite (verschenkter Umsatz).
- Zeiten (Kauf → Auftrag, Ansturm → alles verarbeitet) und Verkehr
  (Aufrufe, Drosselung, Webhooks, Jobs).

Der Lauf endet mit Code 0, wenn alle Prüfungen bestehen.

## Wo der Test nicht echt ist

- Ein einzelner Server statt vieler Vercel-Instanzen: Logikfehler und
  Wettläufe in der Datenbank zeigt er, Kaltstarts und Zeitlimits nicht.
- Der Nachbau verhält sich so, wie Shopify dokumentiert ist. Ob der echte
  Shop bei der Differenz-Meldung mit Vergleichswert genauso antwortet,
  zeigt nur die Generalprobe mit einem Testprodukt im echten Shop.
