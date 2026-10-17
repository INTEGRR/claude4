import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'
import { bestandAuffuellen } from './basis.ts'

/**
 * Retoure (0119, Entscheidungslog 2026-10-17) — der Beweis für den Ablauf,
 * den der Betreiber beschrieben hat: Kunde will das gelieferte Board nicht,
 * wir genehmigen mit Label, das Paket kommt, wird geprüft und verkaufsfähig
 * zurückgebucht; der Shop erstattet (Webhook) — und die Fertigung für einen
 * zweiten, wartenden Auftrag desselben Boards entfällt, weil der Rückläufer
 * ihn deckt. Dazu B-Ware mit Abschluss von Hand und die Ablehnung.
 * Wiederholbar (Staging): Bestellnummern 9400…, frischer MTO-Artikel je Lauf.
 */

const NUTZER = { name: 'prozesstest', role: 'admin' as const }

async function aktion(name: string, recordId: string | undefined, parameter: Record<string, unknown>) {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  return aktionAusfuehrenGeprueft(name as never, { recordId, parameter }, NUTZER)
}

async function naechsteNummer(sql: Sql): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from sales_orders where shopify_order_id like 'gid://shopify/Order/9400%'`
  return 9400000 + Number(n) * 10
}

interface Bestellung {
  gid: string
  name: string
  sku: string
  titel: string
  qty: number
  current?: number
  brutto: string
  finanz?: string
  gesamt?: string
}

function orderObjekt(b: Bestellung) {
  return {
    id: b.gid,
    name: b.name,
    createdAt: '2026-10-10T10:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: b.finanz ?? 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'retoure@example.com',
    tags: [],
    taxesIncluded: true,
    totalPriceSet: { shopMoney: { amount: (Number(b.brutto) * b.qty).toFixed(2), currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: b.gesamt ?? (Number(b.brutto) * (b.current ?? b.qty)).toFixed(2) } },
    customer: {
      id: 'gid://shopify/Customer/737373',
      firstName: 'Rita',
      lastName: 'Retoure',
      defaultEmailAddress: { emailAddress: 'retoure@example.com' },
    },
    shippingAddress: {
      name: 'Rita Retoure', address1: 'Rückweg 5', address2: null, zip: '32457', city: 'Porta Westfalica',
      countryCodeV2: 'DE', phone: null,
    },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${b.gid.split('/').pop()}-1`,
          title: b.titel,
          sku: b.sku,
          quantity: b.qty,
          currentQuantity: b.current ?? b.qty,
          variant: null,
          originalUnitPriceSet: { shopMoney: { amount: b.brutto } },
          discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: b.brutto } },
          taxLines: [{ rate: 0.19 }],
        },
      ],
    },
  }
}

/** Shop-Bestellung hinterlegen und den Webhook so verarbeiten, wie die Route ihn schreibt. */
async function shopWebhook(sql: Sql, b: Bestellung, topic: string): Promise<string> {
  const { fakeOrderHinterlegen } = await import('../../integrationen/shopify-fake.ts')
  fakeOrderHinterlegen(orderObjekt(b) as never)
  const webhookId = `retoure-${b.gid.split('/').pop()}-${topic}-${Date.now()}`
  await sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
            values (${webhookId}, ${topic}, ${b.gid}, ${sql.json({ id: b.gid })})`
  const { processPendingWebhooks } = await import('../../integrationen/import.ts')
  await processPendingWebhooks(10)
  const [ev] = await sql<{ status: string; error: string | null }[]>`
    select status, error from shopify_webhook_events where webhook_id = ${webhookId}`
  assert.equal(ev.status, 'done', `Webhook ${topic}: ${ev.error ?? ev.status}`)
  const [so] = await sql<{ id: string }[]>`select id from sales_orders where shopify_order_id = ${b.gid}`
  assert.ok(so, 'die Bestellung ist als Auftrag da')
  return so.id
}

async function lieferungBuchen(sql: Sql, auftragId: string): Promise<void> {
  const [p] = await sql<{ id: string }[]>`
    select p.id from stock_pickings p join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = ${auftragId} and p.state not in ('done', 'cancel')
    order by p.created_at limit 1`
  assert.ok(p, 'offene Lieferung zum Auftrag')
  await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
}

/** Frischer Made-to-Order-Artikel (Stückliste 1 × Ersatzteil) — ohne Fertigbestand. */
async function mtoArtikel(sql: Sql, ctx: FixtureKontext, nr: number): Promise<{ id: string; sku: string; titel: string }> {
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const titel = `Retourentest-Board ${nr}`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, list_price, weight_g, route_manufacture, route_mto)
    values (${titel}, ${stueck.id}, 125.21, 900, true, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id} and active limit 1`
  const sku = `RT-BOARD-${nr}`
  await sql`update product_variants set sku = ${sku} where id = ${v.id}`
  const [bom] = await sql<{ id: string }[]>`insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await sql`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    select ${bom.id}, 10, ${ctx.teilId}, 1, pt.uom_id, 'backflush'
    from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${ctx.teilId}`
  return { id: v.id, sku, titel }
}

async function erstePosition(sql: Sql, retoureId: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`select id from retoure_positionen where retoure_id = ${retoureId} order by sequence limit 1`
  return p.id
}

/** Gelieferte Shop-Bestellung über das Ersatzteil (Lagerware) — für B-Ware und Ablehnung. */
async function gelieferteTeilBestellung(sql: Sql, ctx: FixtureKontext, suffix: string): Promise<{ auftrag: string; zeile: string }> {
  await bestandAuffuellen(sql, ctx.teilId, 16)
  const nr = await naechsteNummer(sql)
  const auftrag = await shopWebhook(
    sql,
    { gid: `gid://shopify/Order/${nr}`, name: `#RT-${nr}${suffix}`, sku: 'PT-TEIL', titel: 'Prozesstest Ersatzteil', qty: 2, brutto: '29.90' },
    'orders/paid',
  )
  await lieferungBuchen(sql, auftrag)
  const [z] = await sql<{ id: string }[]>`select id from sales_order_lines where order_id = ${auftrag} order by sequence limit 1`
  return { auftrag, zeile: z.id }
}

export const RETOURE_FIXTURE: ProzessFixture = {
  prozess: 'retoure',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Board zurück: genehmigt mit Label, verkaufsfähig geprüft, Shop erstattet → Fertigung des nächsten Auftrags entfällt',
      pfad: ['anlegen', 'genehmigen', 'eingang', 'pruefen', 'shop_erstattet'],
      eingaben: {
        anlegen: async (ctx, sql) => {
          await bestandAuffuellen(sql, ctx.teilId, 16)
          const nr = await naechsteNummer(sql)
          const board = await mtoArtikel(sql, ctx, nr)
          const bestellungA: Bestellung = {
            gid: `gid://shopify/Order/${nr}`, name: `#RT-${nr}A`, sku: board.sku, titel: board.titel, qty: 1, brutto: '149.00',
          }
          const a = await shopWebhook(sql, bestellungA, 'orders/paid')
          const [mo] = await sql<{ id: string }[]>`
            select id from manufacturing_orders where sales_order_id = ${a} and state = 'confirmed'`
          assert.ok(mo, 'Made-to-Order: die Bestellung erzeugt den Fertigungsauftrag')
          await aktion('fertigung.fertig_melden', mo.id, { mengen: {}, backorder: false })
          await lieferungBuchen(sql, a)

          // Der nächste Kunde bestellt dasselbe Board — es wird gefertigt.
          const b = await shopWebhook(
            sql,
            { gid: `gid://shopify/Order/${nr + 1}`, name: `#RT-${nr}B`, sku: board.sku, titel: board.titel, qty: 1, brutto: '149.00' },
            'orders/paid',
          )
          const [moB] = await sql<{ id: string }[]>`
            select id from manufacturing_orders where sales_order_id = ${b} and state = 'confirmed'`
          assert.ok(moB, 'ohne Fertigbestand wird für den zweiten Auftrag gefertigt')
          Object.assign(ctx, { rtAuftragA: a, rtAuftragB: b, rtMoB: moB.id, rtBoard: board.id })
          ctx.rtBestellungA = JSON.stringify(bestellungA)

          const [z] = await sql<{ id: string }[]>`select id from sales_order_lines where order_id = ${a}`
          return {
            record_id: a,
            positionen: [{ zeile: z.id, menge: 1, grund: 'Gefällt mir nicht / passt nicht' }],
            grund: 'Passt nicht zu meinem Setup',
          }
        },
        genehmigen: { label_senden: true },
        pruefen: async (ctx, sql) => ({
          ergebnisse: [{ position: await erstePosition(sql, ctx.retoure_beleg_id), pruefung: 'verkaufsfaehig' }],
        }),
      },
      ereignisse: {
        // Der Shop erstattet die ganze Bestellung (Kunde hat das einzige Board zurückgeschickt).
        shop_erstattet: async (ctx, sql) => {
          const b = JSON.parse(ctx.rtBestellungA) as Bestellung
          await shopWebhook(sql, { ...b, current: 0, finanz: 'REFUNDED', gesamt: '0.00' }, 'orders/updated')
        },
      },
      pruefen: async (sql, ctx, retoureId) => {
        const [r] = await sql<{ status: string; erstattet: boolean; picking_id: string | null; fertigung_info: string | null; nummer: string }[]>`
          select status::text as status, erstattet_am is not null as erstattet, picking_id, fertigung_info, nummer
          from retouren where id = ${retoureId}`
        assert.equal(r.status, 'abgeschlossen', 'die Erstattung schließt die geprüfte Retoure ab')
        assert.ok(r.erstattet)
        // Label mit der Retourennummer, Mail in der Outbox.
        const [label] = await sql<{ n: number }[]>`select count(*)::int as n from return_labels where retoure_id = ${retoureId}`
        assert.equal(label.n, 1, 'genau ein Retourenlabel zur Retoure')
        // Rück-Transfer gebucht, verkaufsfähig ins Lager.
        const [t] = await sql<{ state: string; ziel: string }[]>`
          select sp.state::text as state, l.full_path as ziel from stock_pickings sp
          join stock_moves sm on sm.picking_id = sp.id join stock_locations l on l.id = sm.dest_location_id
          where sp.id = ${r.picking_id}`
        assert.deepEqual([t.state, t.ziel], ['done', 'WH/Stock'])
        // Die Fertigung des zweiten Auftrags entfällt — der Rückläufer ist für seine Lieferung reserviert.
        const [moB] = await sql<{ state: string }[]>`select state::text as state from manufacturing_orders where id = ${ctx.rtMoB}`
        assert.equal(moB.state, 'cancel', 'nicht begonnene Fertigung entfällt')
        const [lief] = await sql<{ reserviert: number; menge: number }[]>`
          select coalesce(sum(sm.reserved_qty), 0)::float as reserviert, coalesce(sum(sm.qty), 0)::float as menge
          from stock_moves sm join stock_pickings sp on sp.id = sm.picking_id
          where sp.origin_model = 'sales_order' and sp.origin_id = ${ctx.rtAuftragB} and sm.state not in ('done', 'cancel')`
        assert.equal(lief.reserviert, lief.menge, 'die Lieferung des zweiten Auftrags ist aus dem Rückläufer gedeckt')
        assert.match(r.fertigung_info ?? '', /Fertigung entfällt/)
        const [aufgabe] = await sql<{ n: number }[]>`
          select count(*)::int as n from aufgaben where rolle = 'fertigung' and titel = ${`Retoure ${r.nummer}: Fertigung anpassen`}`
        assert.equal(aufgabe.n, 1, 'das Team Fertigung bekommt Bescheid')
        // Der volle Shop-Storno nach Lieferung meldet KEINEN Fehler mehr, wenn eine Retoure da ist.
        const [fehler] = await sql<{ n: number }[]>`
          select count(*)::int as n from audit_log where model = 'sales_order' and record_id = ${ctx.rtAuftragA}
            and kind = 'error' and message like 'Ware war bereits%'`
        assert.equal(fehler.n, 0)
      },
    },
    {
      name: 'B-Ware: nach WH/B-Ware (zählt nirgends), Abschluss mit Bestätigung der Erstattung von Hand',
      pfad: ['anlegen', 'genehmigen', 'eingang', 'pruefen', 'abschliessen'],
      eingaben: {
        anlegen: async (ctx, sql) => {
          const { auftrag, zeile } = await gelieferteTeilBestellung(sql, ctx, 'C')
          const [{ frei }] = await sql<{ frei: number }[]>`select free_to_use(${ctx.teilId})::float as frei`
          ctx.rtFreiVorher = String(frei)
          return { record_id: auftrag, positionen: [{ zeile, menge: 1, grund: 'Beschädigt angekommen' }] }
        },
        genehmigen: { label_senden: false },
        pruefen: async (ctx, sql) => ({
          ergebnisse: [{ position: await erstePosition(sql, ctx.retoure_beleg_id), pruefung: 'bware', notiz: 'Kratzer am Gehäuse' }],
        }),
        abschliessen: { erstattung_bestaetigt: true },
      },
      pruefen: async (sql, ctx, retoureId) => {
        const [r] = await sql<{ status: string; erstattet: boolean; fertigung_info: string | null }[]>`
          select status::text as status, erstattet_am is not null as erstattet, fertigung_info from retouren where id = ${retoureId}`
        assert.deepEqual([r.status, r.erstattet, r.fertigung_info], ['abgeschlossen', true, null])
        const [bware] = await sql<{ menge: number }[]>`
          select coalesce(sum(q.on_hand), 0)::float as menge from stock_quants q
          join stock_locations l on l.id = q.location_id
          where l.barcode = 'LOC-WH-BWARE' and q.variant_id = ${ctx.teilId}`
        assert.ok(bware.menge >= 1, 'B-Ware liegt auf WH/B-Ware')
        const [{ frei }] = await sql<{ frei: number }[]>`select free_to_use(${ctx.teilId})::float as frei`
        assert.equal(frei, Number(ctx.rtFreiVorher), 'B-Ware zählt nicht zum freien Bestand (und nicht für den Shop)')
      },
    },
    {
      name: 'Ablehnen: mit Begründung, Mail an den Kunden',
      pfad: ['anlegen', 'ablehnen'],
      eingaben: {
        anlegen: async (ctx, sql) => {
          const { auftrag, zeile } = await gelieferteTeilBestellung(sql, ctx, 'D')
          return { record_id: auftrag, positionen: [{ zeile, menge: 2 }], email: 'retoure@example.com' }
        },
        ablehnen: { grund: 'Die Rückgabefrist von 30 Tagen ist abgelaufen.', mail: true },
      },
      pruefen: async (sql, _ctx, retoureId) => {
        const [r] = await sql<{ status: string; ablehnungsgrund: string | null }[]>`
          select status::text as status, ablehnungsgrund from retouren where id = ${retoureId}`
        assert.deepEqual([r.status, r.ablehnungsgrund], ['abgelehnt', 'Die Rückgabefrist von 30 Tagen ist abgelaufen.'])
        const [job] = await sql<{ n: number }[]>`
          select count(*)::int as n from integration_jobs where kind = 'send_return_rejected_email' and payload ->> 'retoure_id' = ${retoureId}`
        assert.equal(job.n, 1, 'die Ablehnung geht per Mail raus')
      },
    },
  ],
}
