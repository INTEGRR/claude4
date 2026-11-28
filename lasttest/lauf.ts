#!/usr/bin/env -S node --experimental-strip-types
/**
 * Lasttest „Shopify-Ausverkauf" (S8, Entscheidungslog 2026-11-27).
 *
 * Fährt die ECHTE App (next start) gegen den eigenständigen Shop-Nachbau
 * (lasttest/shop-nachbau.mjs) und eine WEGWERF-Datenbank:
 *
 *   1. Sortiment anlegen: 32 Tastaturen (2 Gehäuse × 2 Plates × 4 Switches
 *      × 2 Keycap-Sets), die sich ihre Teile teilen, plus eine einzeln
 *      verkaufte Plate.
 *   2. Erste Meldung abwarten (Kontingente stehen im Shop).
 *   3. Ansturm: N Käufe in wenigen Sekunden, gewichtet nach Beliebtheit.
 *   4. Warten, bis alles verarbeitet ist.
 *   5. Auswerten: Wurde ein Teil überverkauft? War das Angebotene in jedem
 *      Augenblick gedeckt? Sind alle Bestellungen angekommen und voll
 *      reserviert? Wie lange hat es gedauert?
 *
 * Aufruf (siehe lasttest/README.md):
 *   DATABASE_URL=…/erp_lasttest node --experimental-strip-types lasttest/lauf.ts --kaeufe 300 --sekunden 20
 *
 * Schutz: läuft nur gegen eine Datenbank, deren Name „lasttest" enthält.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const arg = (name: string, standard: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : standard
}
const schalter = (name: string): boolean => process.argv.includes(`--${name}`)

const text = (name: string, standard: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? String(process.argv[i + 1]) : standard
}

const KAEUFE = arg('kaeufe', 300)
const SEKUNDEN = arg('sekunden', 20)
const CRON_SEKUNDEN = arg('cron', 20)
const HEILEN = schalter('heilen')
const CHAOS = schalter('chaos')
/** Meldemodus: „baubar" (aufgeteilt, Standard) oder „fest" (feste Menge mit Schnellstopp). */
const MODUS = text('modus', 'baubar') === 'fest' ? 'fest' : 'baubar'
const PUFFER = arg('puffer', 2)
const DECKEL = arg('deckel', MODUS === 'fest' ? 999 : 99)
/** Webhook-Verzug des Shops in ms, „von,bis" — in der Produktion gemessen: 2200 bis 3500. */
const VERZUG = text('verzug', '').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
const APP = (process.env.APP ?? 'http://127.0.0.1:3100').replace(/\/+$/, '')
const NACHBAU = (process.env.NACHBAU ?? 'http://127.0.0.1:4010').replace(/\/+$/, '')
const DB = process.env.DATABASE_URL ?? ''
if (!/lasttest/.test(new URL(DB).pathname)) {
  console.error('Abbruch: DATABASE_URL muss auf eine Wegwerf-Datenbank zeigen, deren Name „lasttest" enthält.')
  process.exit(2)
}
const sql = postgres(DB, { max: 4, onnotice: () => {} })
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function nachbau<T>(pfad: string, body?: unknown): Promise<T> {
  const res = await fetch(`${NACHBAU}${pfad}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

async function cron(task: string): Promise<unknown> {
  const res = await fetch(`${APP}/api/cron?task=${task}`, {
    headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
  })
  return res.json().catch(() => ({ status: res.status }))
}

// --- Sortiment ----------------------------------------------------------------

const TEILE: Record<string, number> = {
  'Gehäuse Schwarz': 70, 'Gehäuse Grün': 22,
  'Plate FR-4': 59, 'Plate PC': 433,
  'Switch Yellow': 2828, 'Switch Brown': 903, 'Switch Blue': 275, 'Switch Silver': 6415,
  'Keycaps Standard': 679, 'Keycaps Frosted': 150,
  PCB: 324,
}
/** Beliebtheit — so verteilen sich die Käufer. */
const WAHL = {
  gehaeuse: [['Gehäuse Schwarz', 0.75], ['Gehäuse Grün', 0.25]],
  plate: [['Plate PC', 0.6], ['Plate FR-4', 0.4]],
  schalter: [['Switch Yellow', 0.4], ['Switch Brown', 0.25], ['Switch Silver', 0.25], ['Switch Blue', 0.1]],
  keycaps: [['Keycaps Standard', 0.7], ['Keycaps Frosted', 0.3]],
} as const

interface Angebot { gid: string; item: string; produkt: string; sku: string; titel: string; bedarf: [string, number][]; gewicht: number; lagerartikel?: boolean }

async function sortimentAnlegen(): Promise<{ angebote: Angebot[]; teilIds: Map<string, string> }> {
  const [uom] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [lager] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const lauf = Date.now().toString(36)
  const teilIds = new Map<string, string>()
  // Sortimente früherer Läufe vom Shop abkoppeln — der Nachbau kennt sie nicht mehr.
  await sql`update product_variants set shopify_variant_id = null, shopify_inventory_item_gid = null
            where sku like 'LT-%' and shopify_variant_id is not null`

  for (const [name, bestand] of Object.entries(TEILE)) {
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold) values (${`${name} [${lauf}]`}, ${uom.id}, false) returning id`
    await sql`select generate_variants(${tpl.id})`
    const [v] = await sql<{ id: string }[]>`
      update product_variants set sku = ${`LT-${name.replace(/\W+/g, '-').toUpperCase()}-${lauf}`} where template_id = ${tpl.id} returning id`
    const [z] = await sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty) values (${lager.id}, ${v.id}, ${bestand}, 0) returning id`
    await sql`select inventory_apply(${z.id}, 'lasttest')`
    teilIds.set(name, v.id)
  }

  const angebote: Angebot[] = []
  let nr = 500000 + Math.floor(Math.random() * 100000) * 100
  for (const [g, pg] of WAHL.gehaeuse) for (const [p, pp] of WAHL.plate) for (const [s, ps] of WAHL.schalter) for (const [k, pk] of WAHL.keycaps) {
    nr++
    const titel = `Tastatur ${g.replace('Gehäuse ', '')} / ${p.replace('Plate ', '')} / ${s.replace('Switch ', '')} / ${k.replace('Keycaps ', '')}`
    const sku = `LT-KB-${nr}`
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold, route_manufacture, route_mto)
      values (${`${titel} [${lauf}]`}, ${uom.id}, true, true, true) returning id`
    await sql`select generate_variants(${tpl.id})`
    const gid = `gid://shopify/ProductVariant/${nr}`
    const item = `gid://shopify/InventoryItem/${nr}`
    await sql`update product_variants set sku = ${sku}, shopify_variant_id = ${gid}, shopify_inventory_item_gid = ${item}
              where template_id = ${tpl.id}`
    const [bom] = await sql<{ id: string }[]>`insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom.id}) returning id`
    const zeilen: [string, number][] = [[g, 1], [p, 1], [s, 85], [k, 1], ['PCB', 1]]
    let seq = 10
    for (const [teil, menge] of zeilen) {
      await sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
                values (${bom.id}, ${seq}, ${teilIds.get(teil)!}, ${menge}, ${uom.id})`
      seq += 10
    }
    angebote.push({ gid, item, produkt: `gid://shopify/Product/${nr}`, sku, titel, bedarf: zeilen, gewicht: pg * pp * ps * pk })
  }

  // Die FR-4-Plate wird auch einzeln verkauft — höchstens 5 gleichzeitig, 20 bleiben der Fertigung.
  nr++
  const plate = teilIds.get('Plate FR-4')!
  const gid = `gid://shopify/ProductVariant/${nr}`
  const item = `gid://shopify/InventoryItem/${nr}`
  await sql`update product_templates set can_be_sold = true where id = (select template_id from product_variants where id = ${plate})`
  await sql`update product_variants set shopify_variant_id = ${gid}, shopify_inventory_item_gid = ${item},
                                      shop_rueckhalt = 20, shop_hoechstmenge = 5 where id = ${plate}`
  const [{ sku: plateSku }] = await sql<{ sku: string }[]>`select sku from product_variants where id = ${plate}`
  angebote.push({ gid, item, produkt: `gid://shopify/Product/${nr}`, sku: plateSku, titel: 'Plate FR-4 einzeln', bedarf: [['Plate FR-4', 1]], gewicht: 0.03, lagerartikel: true })

  await sql`
    insert into settings (key, value) values ('shopify', ${sql.json({ modus: 'schreiben', mto: { modus: MODUS, puffer: PUFFER, deckel: DECKEL } })})
    on conflict (key) do update set value = settings.value || excluded.value`
  await sql`update shopify_inventory_state set pushed_qty = null, buch_ab = null`
  await sql`delete from shopify_sync_state where key in ('inventory_location', 'inventar_sperre')`
  return { angebote, teilIds }
}

// --- Lauf -----------------------------------------------------------------------

interface Stand {
  zaehler: Record<string, number>
  offeneWebhooks: number
  bestellungen: number
  angebote: { gid: string; sku: string; verfuegbar: number; tracked: boolean; policy: string }[]
  teile: { id: string; anfang: number; verkauft: number }[]
  verletzungen: number
}

function waehlen<T extends { gewicht: number }>(liste: T[]): T {
  let r = Math.random() * liste.reduce((s, a) => s + a.gewicht, 0)
  for (const a of liste) {
    r -= a.gewicht
    if (r <= 0) return a
  }
  return liste[liste.length - 1]
}

const perzentil = (werte: number[], p: number): number => {
  if (werte.length === 0) return 0
  const s = [...werte].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function ruheAbwarten(maxSekunden: number): Promise<number> {
  const start = Date.now()
  let ruhig = 0
  while ((Date.now() - start) / 1000 < maxSekunden) {
    await cron('webhooks')
    await cron('jobs')
    const stand = await nachbau<Stand>('/_stand')
    const [{ offen }] = await sql<{ offen: number }[]>`
      select (select count(*) from shopify_webhook_events where status = 'pending' and attempts < 5)
           + (select count(*) from integration_jobs where status in ('pending', 'running') and kind = 'shopify_inventory_push') as offen`
    if (stand.offeneWebhooks === 0 && Number(offen) === 0) {
      if (++ruhig >= 3) break
    } else {
      ruhig = 0
    }
    await pause(1000)
  }
  return (Date.now() - start) / 1000
}

async function main(): Promise<void> {
  console.log(`Lasttest: ${KAEUFE} Käufe in ${SEKUNDEN} s — App ${APP}, Shop-Nachbau ${NACHBAU}; Modus ${MODUS}, Puffer ${PUFFER}, Menge ${DECKEL}`)
  const { angebote, teilIds } = await sortimentAnlegen()
  await nachbau('/_einrichten', {
    teile: Object.entries(TEILE).map(([id, anfang]) => ({ id, anfang })),
    angebote: angebote.map(({ gewicht: _g, ...a }) => a),
    // --chaos: Webhooks bis vier Sekunden verzögert, 30 % doppelt, 15 % bis 15 s verspätet, halbes Abruf-Kontingent.
    einstellung: CHAOS
      ? { verzoegerung: [50, 4000], doppelt: 0.3, spaetAnteil: 0.15, spaet: 15000, eimer: 1000, auffuellung: 50 }
      : VERZUG.length === 2 ? { verzoegerung: VERZUG } : {},
  })
  const teilName = new Map([...teilIds].map(([name, id]) => [id, name]))

  // Erste Meldung: richtet die Tastaturen ein (Menge verfolgen, nicht weiterverkaufen) und setzt die Kontingente.
  await cron('jobs')
  for (let i = 0; i < 30; i++) {
    const s = await nachbau<Stand>('/_stand')
    if (s.angebote.filter((a) => a.sku.startsWith('LT-KB')).every((a) => a.tracked && a.policy === 'DENY') && s.angebote.some((a) => a.verfuegbar > 0)) break
    await pause(500)
    await cron('jobs')
  }
  // Das Buch zählt Bestellungen erst fünf Sekunden nach einer absoluten Meldung — im Betrieb liegt
  // das Scharfschalten Stunden vor dem Release, hier warten wir die Frist ab.
  await pause(7000)
  const anfang = await nachbau<Stand>('/_stand')
  console.log(`Start: ${anfang.angebote.reduce((s, a) => s + Math.max(a.verfuegbar, 0), 0)} Stück im Shop angeboten auf ${anfang.angebote.filter((a) => a.verfuegbar > 0).length} von ${anfang.angebote.length} Angeboten; Verletzungen bisher: ${anfang.verletzungen}`)

  // Ansturm.
  const tStart = Date.now()
  const takt = setInterval(() => void cron('jobs').then(() => cron('webhooks')), CRON_SEKUNDEN * 1000)
  const kaeufe: { t: number; sku: string; ok: boolean; bestellung?: string; grund?: string }[] = []
  await Promise.all(
    Array.from({ length: KAEUFE }, async () => {
      await pause(Math.random() * SEKUNDEN * 1000)
      const a = waehlen(angebote)
      const r = await nachbau<{ ok: boolean; bestellung?: string; grund?: string }>('/_kauf', { variantGid: a.gid, menge: 1 })
      kaeufe.push({ t: Date.now(), sku: a.sku, ok: r.ok, bestellung: r.bestellung, grund: r.grund })
    }),
  )
  const tAnsturmEnde = Date.now()
  console.log(`Ansturm vorbei: ${kaeufe.filter((k) => k.ok).length} gekauft, ${kaeufe.filter((k) => !k.ok).length} „ausverkauft". Warte auf die Verarbeitung …`)
  const wartezeit = await ruheAbwarten(240)
  clearInterval(takt)

  // Abgleich wie der Viertelstunden-Cron: Shop-Stand lesen, Buch heilen.
  await cron('reconcile')
  await ruheAbwarten(30)
  if (HEILEN) {
    console.log('Warte 190 s auf „ruhige Zeit", dann heilt der Abgleich auch nach unten …')
    await pause(190_000)
    await cron('reconcile')
    await ruheAbwarten(30)
  }

  // --- Auswertung -------------------------------------------------------------
  const ende = await nachbau<Stand>('/_stand')
  const { protokoll, verletzungen } = await nachbau<{
    protokoll: { t: number; art: string; [k: string]: unknown }[]
    verletzungen: { t: number; anlass: string; teil: string; angeboten: number; rest: number; ueber: number }[]
  }>('/_protokoll')
  const gekauft = kaeufe.filter((k) => k.ok)

  const auftraege = await sql<{ shopify_order_id: string; state: string; created_at: Date }[]>`
    select shopify_order_id, state::text as state, created_at from sales_orders where shopify_order_name like '#L%'
      and created_at > ${new Date(tStart - 60_000)}`
  const nachGid = new Map(auftraege.map((a) => [a.shopify_order_id, a]))
  const fehlend = gekauft.filter((k) => !nachGid.has(k.bestellung!))
  const latenz = gekauft.flatMap((k) => {
    const a = nachGid.get(k.bestellung!)
    return a ? [(a.created_at.getTime() - k.t) / 1000] : []
  })
  const [{ ungedeckt }] = await sql<{ ungedeckt: number }[]>`
    select count(distinct mo.sales_order_id)::int as ungedeckt
    from stock_moves m
    join manufacturing_orders mo on mo.id = m.production_id
    join stock_locations l on l.id = m.src_location_id and l.type = 'internal'
    join sales_orders so on so.id = mo.sales_order_id and so.shopify_order_name like '#L%'
    where m.state not in ('done', 'cancel', 'draft') and m.qty > m.reserved_qty and so.created_at > ${new Date(tStart - 60_000)}`
  const ereignisse = await sql<{ status: string; topic: string; n: number; versuche: number }[]>`
    select status::text as status, split_part(topic, '/', 1) as topic, count(*)::int as n, max(attempts)::int as versuche
    from shopify_webhook_events where received_at > ${new Date(tStart - 60_000)} group by 1, 2 order by 2, 1`
  const jobs = await sql<{ status: string; n: number }[]>`
    select status::text as status, count(*)::int as n from integration_jobs
    where kind = 'shopify_inventory_push' and created_at > ${new Date(tStart - 60_000)} group by 1`
  const fehlerLog = await sql<{ kind: string; n: number; beispiel: string | null }[]>`
    select kind, count(*)::int as n, max(left(error, 160)) as beispiel from api_transactions
    where not ok and created_at > ${new Date(tStart - 60_000)} group by 1 order by 2 desc limit 10`
  const [{ meldungen }] = await sql<{ meldungen: number }[]>`
    select count(*)::int as meldungen from benachrichtigungen where art = 'ueberverkauf' and erstellt_at > ${new Date(tStart - 60_000)}`
  const buch = await sql<{ sku: string; kontingent: number | null; buch: number | null }[]>`
    select v.sku, s.kontingent, s.pushed_qty::float as buch from shopify_inventory_state s
    join product_variants v on v.id = s.variant_id where v.shopify_variant_id is not null and v.sku like 'LT-%'`
  const frei = await sql<{ id: string; frei: number }[]>`
    select v.id, free_to_use(v.id)::float as frei from product_variants v where v.id = any(${[...teilIds.values()]}::uuid[])`

  const shopJeSku = new Map(ende.angebote.map((a) => [a.sku, a.verfuegbar]))
  const vergleich = buch.map((b) => ({ sku: b.sku, kontingent: b.kontingent ?? 0, buch: b.buch, shop: shopJeSku.get(b.sku) ?? 0 }))
  const shopMehr = vergleich.filter((v) => v.shop > v.kontingent)
  const shopWeniger = vergleich.filter((v) => v.shop < v.kontingent)

  const ueberverkauft = ende.teile.filter((t) => t.verkauft > t.anfang)
  const meldungenArt = (art: string) => protokoll.filter((p) => p.art === art).length
  const letzteMeldung = Math.max(0, ...protokoll.filter((p) => p.art === 'differenz' || p.art === 'absolut').map((p) => p.t))
  const letzterKauf = Math.max(0, ...gekauft.map((k) => k.t))

  // Im Shop angeboten vs. durch Teile gedeckt — am Ende.
  const angebotenEnde = new Map<string, number>()
  for (const a of angebote) {
    const stueck = Math.max(shopJeSku.get(a.sku) ?? 0, 0)
    for (const [teil, je] of a.bedarf) angebotenEnde.set(teil, (angebotenEnde.get(teil) ?? 0) + stueck * je)
  }
  const teilTabelle = ende.teile.map((t) => {
    const f = frei.find((x) => teilName.get(x.id) === t.id)?.frei ?? 0
    return { teil: t.id, anfang: t.anfang, verkauft: t.verkauft, rest: t.anfang - t.verkauft, freiKrnl: f, angeboten: angebotenEnde.get(t.id) ?? 0 }
  })

  // Feste Menge bietet mit Absicht mehr an, als Teile da sind (jedes Angebot steht voll) — dort zählt
  // allein, ob am Ende ein Teil überverkauft wurde. Die „Augenblicke ohne Deckung" gelten nur aufgeteilt.
  const fest = MODUS === 'fest'
  const bestanden =
    ueberverkauft.length === 0 && fehlend.length === 0 && Number(ungedeckt) === 0 &&
    (fest || (verletzungen.length === 0 && shopMehr.length === 0))

  // Wie schnell kam der Stopp? Je Teil: vom Kauf, der es auf die Schwelle brachte, bis alle Angebote mit dem Teil auf 0 standen.
  const stopps = ende.teile.flatMap((teil) => {
    const mit = angebote.filter((a) => !a.lagerartikel && a.bedarf.some(([t]) => t === teil.id))
    const je = mit[0]?.bedarf.find(([t]) => t === teil.id)?.[1] ?? 1
    const reicht = Math.floor(teil.anfang / je)
    const skus = new Set(mit.map((a) => a.sku))
    const stand = new Map<string, number | null>(mit.map((a) => [a.sku, null]))
    let verkauft = 0
    let tSchwelle: number | null = null
    let tStopp: number | null = null
    let danach = 0
    for (const p of [...protokoll].sort((x, y) => x.t - y.t)) {
      const sku = String(p.sku ?? '')
      if (!skus.has(sku)) continue
      if (p.art === 'kauf') {
        verkauft += Number(p.menge ?? 1)
        if (tSchwelle === null && reicht - verkauft <= PUFFER) tSchwelle = p.t
        else if (tSchwelle !== null) danach += Number(p.menge ?? 1)
      }
      if (p.art === 'kauf' || p.art === 'differenz' || p.art === 'absolut') {
        stand.set(sku, Number(p.danach))
        if (tSchwelle !== null && tStopp === null && [...stand.values()].every((v) => v === 0)) tStopp = p.t
      }
    }
    return tSchwelle === null ? [] : [{ teil: teil.id, reicht, verkauft, danach, sekunden: tStopp === null ? null : (tStopp - tSchwelle) / 1000 }]
  })
  const z = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 })
  const bericht = [
    `# Lasttest ${new Date(tStart).toISOString().slice(0, 19).replace('T', ' ')} — ${bestanden ? 'BESTANDEN' : 'NICHT BESTANDEN'}`,
    '',
    `${KAEUFE} Kaufversuche in ${SEKUNDEN} s (${z(KAEUFE / SEKUNDEN)} je Sekunde) auf ${angebote.length} Angebote mit geteilten Teilen.${CHAOS ? ' Störmodus: Webhooks stark verzögert, doppelt und verspätet, halbes Abruf-Kontingent.' : ''}`,
    `Meldemodus: ${fest ? `feste Menge ${DECKEL}, Schwelle ${PUFFER} Stück je Teil (Schnellstopp)` : `aufgeteilt (Kontingent), Puffer ${PUFFER}, Deckel ${DECKEL}`}.${VERZUG.length === 2 ? ` Webhook-Verzug ${VERZUG[0]}–${VERZUG[1]} ms.` : ''}`,
    '',
    '## Ergebnis',
    '',
    '| Prüfung | Ergebnis |',
    '|---|---|',
    `| Teile überverkauft | ${ueberverkauft.length === 0 ? 'keines' : ueberverkauft.map((t) => `${t.id}: ${t.verkauft} von ${t.anfang}`).join('; ')} |`,
    `| Augenblicke, in denen der Shop mehr anbot, als Teile da waren | ${fest ? 'entfällt (feste Menge bietet mit Absicht voll an)' : verletzungen.length} |`,
    `| Käufe angenommen / abgewiesen (ausverkauft) | ${gekauft.length} / ${kaeufe.length - gekauft.length} |`,
    `| Bestellungen in KRNL angekommen | ${gekauft.length - fehlend.length} von ${gekauft.length} |`,
    `| Bestellungen ohne volle Reservierung | ${ungedeckt} |`,
    `| Überverkaufs-Meldungen (Telegram) | ${meldungen} |`,
    `| Shop zeigt am Ende mehr als das Kontingent | ${shopMehr.length} Angebote |`,
    `| Shop zeigt am Ende weniger als das Kontingent (sichere Seite) | ${shopWeniger.length} Angebote |`,
    '',
    '## Zeiten',
    '',
    '| Messung | Wert |',
    '|---|---|',
    `| Kauf → Auftrag in KRNL (Median / 95 % / längste) | ${z(perzentil(latenz, 50))} s / ${z(perzentil(latenz, 95))} s / ${z(Math.max(0, ...latenz))} s |`,
    `| Letzter Kauf → letzte Mengenmeldung an den Shop | ${z((letzteMeldung - letzterKauf) / 1000)} s |`,
    `| Ansturm-Ende → alles verarbeitet | ${z(wartezeit)} s |`,
    '',
    '## Verkehr',
    '',
    '| Messung | Wert |',
    '|---|---|',
    `| Aufrufe an den Shop | ${ende.zaehler.aufrufe} |`,
    `| davon gedrosselt | ${ende.zaehler.gedrosselt} |`,
    `| Meldungen: absolut / Differenz | ${meldungenArt('absolut')} / ${meldungenArt('differenz')} Positionen |`,
    `| Senkungen abgelehnt (unbekannter Kauf lag darauf) | ${ende.zaehler.veraltet} |`,
    `| Webhooks zugestellt / abgewiesen | ${ende.zaehler.webhooks} / ${ende.zaehler.webhookFehler} |`,
    `| Webhook-Ereignisse | ${ereignisse.map((e) => `${e.topic}: ${e.n} ${e.status}${e.versuche > 0 ? ` (bis ${e.versuche} Versuche)` : ''}`).join('; ') || '—'} |`,
    `| Abgleich-Jobs | ${jobs.map((j) => `${j.n} ${j.status}`).join(', ') || '—'} |`,
    '',
    ...(stopps.length > 0
      ? ['## Stopp je Teil', '',
        '| Teil | reicht für | verkauft | Käufe nach der Schwelle | Schwelle → alle Angebote auf 0 |', '|---|---|---|---|---|',
        ...stopps.map((x) => `| ${x.teil} | ${x.reicht} | ${x.verkauft} | ${x.danach} | ${x.sekunden === null ? '—' : `${z(x.sekunden)} s`} |`), '']
      : []),
    '## Teile',
    '',
    '| Teil | Anfang | verkauft | Rest | frei in KRNL | im Shop noch angeboten |',
    '|---|---|---|---|---|---|',
    ...teilTabelle.map((t) => `| ${t.teil} | ${t.anfang} | ${t.verkauft} | ${t.rest} | ${t.freiKrnl} | ${t.angeboten} |`),
    '',
    ...(verletzungen.length > 0 && !fest
      ? ['## Verletzungen (erste 20)', '', '| Anlass | Teil | angeboten | Rest | zu viel |', '|---|---|---|---|---|',
        ...verletzungen.slice(0, 20).map((v) => `| ${v.anlass} | ${v.teil} | ${v.angeboten} | ${v.rest} | ${v.ueber} |`), '']
      : []),
    ...(fehlerLog.length > 0
      ? ['## Fehler im Protokoll der App', '', '| Aufruf | Anzahl | Beispiel |', '|---|---|---|',
        ...fehlerLog.map((f) => `| ${f.kind} | ${f.n} | ${(f.beispiel ?? '').replace(/\|/g, '/')} |`), '']
      : []),
    ...(shopMehr.length > 0 && !fest
      ? ['## Shop über Kontingent', '', ...shopMehr.map((v) => `- ${v.sku}: Shop ${v.shop}, Kontingent ${v.kontingent}, Buch ${v.buch}`), '']
      : []),
  ].join('\n')

  const ordner = join(import.meta.dirname, 'ergebnis')
  mkdirSync(ordner, { recursive: true })
  const datei = join(ordner, `${new Date(tStart).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`)
  writeFileSync(datei, bericht)
  writeFileSync(datei.replace(/\.md$/, '.json'), JSON.stringify({ kaeufe, protokoll, verletzungen, vergleich, teilTabelle, stopps }, null, 1))
  console.log(`\n${bericht}\n\nBericht: ${datei}`)
  await sql.end()
  process.exit(bestanden ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await sql.end()
  process.exit(3)
})
