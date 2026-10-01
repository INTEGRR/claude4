import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * Eingangssendung (0108): Sammelfracht mit Bestellungen zweier Lieferanten.
 * Drei Läufe — See mit Verzollung durch den Spediteur bis zur Abrechnung
 * (Fracht und Zoll als Landed Costs, EUSt getrennt), Express (der Kurier
 * verzollt selbst: von „verschifft" direkt „angekommen") und die Storno vor
 * dem Verschiffen. Der Teilprozess Wareneingang sind die Eingänge der
 * Bestellungen, die an der Sendung hängen.
 */

const NUTZER = { name: 'prozesstest', role: 'admin' as const }

async function aktion(name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  return aktionAusfuehrenGeprueft(name, { recordId, parameter }, NUTZER)
}

async function partner(sql: Sql, name: string, land: string, sprache: string): Promise<string> {
  const [da] = await sql<{ id: string }[]>`select id from partners where name = ${name} limit 1`
  if (da) return da.id
  const [p] = await sql<{ id: string }[]>`
    insert into partners (name, is_vendor, is_company, sprache, country_code, standard_waehrung, email)
    values (${name}, true, true, ${sprache}, ${land}, 'EUR', ${`${name.split(' ')[0].toLowerCase()}@sendung-test.example`})
    returning id`
  return p.id
}

async function artikel(sql: Sql, sku: string, name: string, gewichtG: number, hs: string): Promise<string> {
  const [da] = await sql<{ id: string }[]>`select id from product_variants where sku = ${sku} limit 1`
  if (da) return da.id
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g, hs_code, can_be_purchased)
    values (${name}, ${stueck.id}, ${gewichtG}, ${hs}, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id} limit 1`
  await sql`update product_variants set sku = ${sku} where id = ${v.id}`
  return v.id
}

/** Zwei frische, bestätigte Bestellungen (je Lauf neu — Staging-wiederholbar). */
async function zweiBestellungen(ctx: FixtureKontext): Promise<[string, string]> {
  const a = await aktion('einkauf.bestellung_mit_positionen', undefined, {
    lieferant: ctx.sendungLieferantA,
    positionen: [{ produkt: 'PT-ES-PCB', menge: 100, preis: 4 }],
  })
  const b = await aktion('einkauf.bestellung_mit_positionen', undefined, {
    lieferant: ctx.sendungLieferantB,
    positionen: [{ produkt: 'PT-ES-CAP', menge: 200, preis: 3 }],
  })
  await aktion('einkauf.bestaetigen', a.recordId)
  await aktion('einkauf.bestaetigen', b.recordId)
  return [a.recordId!, b.recordId!]
}

async function eingaengeBuchen(sql: Sql, sendungId: string): Promise<void> {
  const eingaenge = await sql<{ id: string }[]>`
    select id from stock_pickings where eingangs_sendung_id = ${sendungId} and state not in ('done', 'cancel')`
  assert.ok(eingaenge.length > 0, 'an der Sendung hängen offene Wareneingänge')
  for (const e of eingaenge) await sql`select picking_validate(${e.id}, '{}'::jsonb, false)`
}

export const EINGANGS_SENDUNG_FIXTURE: ProzessFixture = {
  prozess: 'eingangs_sendung',
  benoetigt: ['basis'],
  aufbauen: async (sql, ctx) => {
    ctx.sendungLieferantA = await partner(sql, 'Shenzhen PCB Works (Sendungstest)', 'CN', 'zh')
    ctx.sendungLieferantB = await partner(sql, 'Dongguan Keycaps Ltd. (Sendungstest)', 'CN', 'en')
    ctx.sendungSpediteur = await partner(sql, 'Kühne Nagel (Sendungstest)', 'DE', 'de')
    await artikel(sql, 'PT-ES-PCB', 'Platine (Sendungstest)', 50, '85340090')
    await artikel(sql, 'PT-ES-CAP', 'Keycap-Set (Sendungstest)', 100, '84733020')
  },
  laeufe: [
    {
      name: 'Sammelsendung See: zwei Lieferanten, Spediteur verzollt, Kosten auf die Eingänge verteilt',
      pfad: ['anlegen', 'verschiffen', 'verzollen', 'ankommen', 'wareneingang', 'abrechnen'],
      eingaben: {
        anlegen: async (ctx) => {
          const [a, b] = await zweiBestellungen(ctx)
          ctx.sendungPoA = a
          ctx.sendungPoB = b
          return { modus: 'see', bezeichnung: 'LCL Shenzhen (Prozesstest)', spediteur_id: ctx.sendungSpediteur, gewicht_kg: 25, bestellungen: [a, b] }
        },
        verschiffen: { hbl_awb: 'KNHAM123456' },
      },
      ereignisse: {
        // Teilprozess Wareneingang: beide Eingänge buchen, dazu Frachtrechnung
        // und Zollbescheid — erst danach bietet der Prozess „abrechnen" an.
        wareneingang: async (ctx, sql) => {
          const id = ctx.eingangs_sendung_beleg_id
          await eingaengeBuchen(sql, id)
          await aktion('einkauf.sendung_kosten_erfassen', id, { art: 'fracht', betrag: 300, partner_id: ctx.sendungSpediteur })
          await aktion('einkauf.sendung_zoll_erfassen', id, {
            zeilen: [
              { hs_code: '85340090', zollwert_eur: 430, zoll_eur: 0, eust_eur: 81.7 },
              { hs_code: '84733020', zollwert_eur: 660, zoll_eur: 13.2, eust_eur: 127.91 },
            ],
          })
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx, id) => {
        const [s] = await sql<{ status: string }[]>`select status::text as status from eingangs_sendungen where id = ${id}`
        assert.equal(s.status, 'abgerechnet')
        const [lc] = await sql<{ summe: number; eust: number }[]>`
          select coalesce(sum(l.amount) filter (where l.state = 'posted'), 0) as summe,
                 count(*) filter (where k.art = 'eust') as eust
          from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
          where k.sendung_id = ${id}`
        assert.equal(Number(lc.summe), 313.2, 'Fracht 300 + Zoll 13,20 verteilt')
        assert.equal(Number(lc.eust), 0, 'die EUSt wird nie verteilt')
        const pos = await sql<{ verschifft_am: string | null }[]>`
          select verschifft_am::text as verschifft_am from purchase_orders where id in (${ctx.sendungPoA}, ${ctx.sendungPoB})`
        assert.ok(pos.every((p) => p.verschifft_am), 'beide Bestellungen tragen den Verschiffungstag')
      },
    },
    {
      name: 'Express vom Lieferanten: der Kurier verzollt selbst',
      pfad: ['anlegen', 'verschiffen', 'ankommen', 'wareneingang', 'abrechnen'],
      eingaben: {
        anlegen: async (ctx) => {
          const [a] = await zweiBestellungen(ctx)
          return { modus: 'express', traeger: 'DHL Express', bestellungen: [a] }
        },
      },
      ereignisse: {
        wareneingang: async (ctx, sql) => {
          await eingaengeBuchen(sql, ctx.eingangs_sendung_beleg_id)
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [s] = await sql<{ status: string; verzollt_am: string | null }[]>`
          select status::text as status, verzollt_am::text as verzollt_am from eingangs_sendungen where id = ${id}`
        assert.deepEqual({ ...s }, { status: 'abgerechnet', verzollt_am: null })
      },
    },
    {
      name: 'Storno vor dem Verschiffen — die Wareneingänge lösen sich',
      pfad: ['anlegen', 'stornieren'],
      eingaben: {
        anlegen: async (ctx) => {
          const [a] = await zweiBestellungen(ctx)
          return { bestellungen: [a] }
        },
        stornieren: { grund: 'Buchung beim Spediteur entfallen' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [s] = await sql<{ status: string; storno_grund: string }[]>`
          select status::text as status, storno_grund from eingangs_sendungen where id = ${id}`
        assert.equal(s.status, 'storniert')
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stock_pickings where eingangs_sendung_id = ${id}`
        assert.equal(Number(n), 0)
      },
    },
  ],
}
