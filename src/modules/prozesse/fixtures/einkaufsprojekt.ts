import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * Einkaufsprojekt (0097) mit Gmail-/Drive-Attrappe und festen Kursen:
 * Neuteil mit zwei Positionen → Anfragen an einen chinesischen und einen
 * US-Lieferanten (Entwürfe, Sammelfreigabe) → zwei Angebote (CNY FOB mit
 * Werkzeugkosten, USD DDP) → Entscheidung → Bestellung mit neuen Artikeln,
 * Zahlplan und Lieferantenpreisen → Abschluss von selbst beim Wareneingang.
 * Dazu der Kurzweg „Angebot liegt schon vor" (Betriebsausstattung, von
 * Hand abgeschlossen), der Abbruch und (Stufe 4, 0107) die Musterpflicht:
 * ohne Golden Sample verweigert die Datenbank die Bestellung, der Weg führt
 * durch den Teilprozess Bemusterung; Werkzeugkosten legen das Werkzeug an.
 */

const NUTZER = { name: 'prozesstest', role: 'admin' as const }

async function lieferant(sql: Sql, name: string, email: string, sprache: string, land: string): Promise<string> {
  const [da] = await sql<{ id: string }[]>`select id from partners where name = ${name} limit 1`
  if (da) return da.id
  const [p] = await sql<{ id: string }[]>`
    insert into partners (name, is_vendor, is_company, email, sprache, country_code)
    values (${name}, true, true, ${email}, ${sprache}, ${land}) returning id`
  return p.id
}

async function aktion(name: string, recordId: string | undefined, parameter: Record<string, unknown>) {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  return aktionAusfuehrenGeprueft(name, { recordId, parameter }, NUTZER)
}

async function positionen(sql: Sql, projektId: string) {
  return sql<{ id: string; bezeichnung: string }[]>`
    select id, bezeichnung from einkaufsprojekt_positionen where projekt_id = ${projektId} order by sequence`
}

const projektId = (ctx: FixtureKontext) => ctx.einkaufsprojekt_beleg_id

export const EINKAUFSPROJEKT_FIXTURE: ProzessFixture = {
  prozess: 'einkaufsprojekt',
  benoetigt: ['basis'],
  aufbauen: async (sql, ctx) => {
    ctx.cnLieferantId = await lieferant(sql, 'Dongguan Keycap Co. (Prozesstest)', 'sales@keycap-test.cn', 'zh', 'CN')
    ctx.usLieferantId = await lieferant(sql, 'Keycap Supply Inc. (Prozesstest)', 'orders@keycap-test.us', 'en', 'US')
    // Feste Kurse von gestern (EUR je Fremdeinheit) — wiederholbar, ohne EZB.
    await sql`
      insert into exchange_rates (currency, rate, valid_from, source)
      values ('USD', 0.92, current_date - 1, 'fixture'), ('CNY', 0.128, current_date - 1, 'fixture')
      on conflict (currency, valid_from) do nothing`
  },
  laeufe: [
    {
      name: 'Neuteil: zwei Lieferanten anfragen, Angebote vergleichen, bestellen, Abschluss beim Wareneingang',
      pfad: ['anlegen', 'anfragen', 'entscheiden', 'bestellen'],
      eingaben: {
        anlegen: {
          titel: 'Keycap-Set PBT (Prozesstest)',
          art: 'neuteil',
          zieltermin: '2026-12-01',
          positionen: [
            { bezeichnung: 'Keycap-Set PBT Dye-Sub (Prozesstest)', menge: 500, zielpreis_eur: 9, gewicht_g: 180, hs_code: '847330' },
            { bezeichnung: 'Keycap-Puller (Prozesstest)', menge: 500, zielpreis_eur: 0.5, gewicht_g: 12, hs_code: '3926' },
          ],
        },
        // Vor der Sammelfreigabe: je Lieferant ein Entwurf in dessen Sprache.
        anfragen: async (ctx) => {
          await aktion('einkauf.anfragen_senden', projektId(ctx), {
            partner_ids: [ctx.cnLieferantId, ctx.usLieferantId],
            frist: '2026-10-15',
          })
          return {}
        },
        entscheiden: async (ctx, sql) => {
          const [set, puller] = await positionen(sql, projektId(ctx))
          await aktion('einkauf.angebot_erfassen', projektId(ctx), {
            partner_id: ctx.cnLieferantId,
            waehrung: 'CNY',
            incoterm_code: 'FOB',
            incoterm_ort: 'Shenzhen',
            anzahlung_pct: 30,
            lieferzeit_tage: 35,
            werkzeugkosten: 3000,
            fracht_modus: 'see',
            staffeln: [
              { position_id: set.id, ab_menge: 300, preis: 52 },
              { position_id: set.id, ab_menge: 1000, preis: 45 },
              { position_id: puller.id, ab_menge: 500, preis: 1.2 },
            ],
          })
          const us = await aktion('einkauf.angebot_erfassen', projektId(ctx), {
            partner_id: ctx.usLieferantId,
            waehrung: 'USD',
            incoterm_code: 'DDP',
            anzahlung_pct: 30,
            lieferzeit_tage: 20,
            staffeln: [
              { position_id: set.id, ab_menge: 100, preis: 10.5 },
              { position_id: puller.id, ab_menge: 100, preis: 0.4 },
            ],
          })
          return { angebot_id: us.daten!.angebot_id, begruendung: 'DDP, schneller' }
        },
      },
      pruefen: async (sql, ctx, id) => {
        const [anfragen] = await sql<{ n: number; entwuerfe: number }[]>`
          select count(*)::int as n,
                 count(*) filter (where e.status in ('freigegeben', 'gesendet'))::int as entwuerfe
          from lieferantenanfragen a join mail_entwuerfe e on e.id = a.entwurf_id
          where a.projekt_id = ${id}`
        assert.deepEqual(anfragen, { n: 2, entwuerfe: 2 }, 'zwei Anfragen, beide freigegeben')

        const [po] = await sql<{ id: string; currency: string; incoterm_code: string; state: string }[]>`
          select id, currency, incoterm_code, state::text as state from purchase_orders where einkaufsprojekt_id = ${id}`
        assert.deepEqual({ currency: po.currency, incoterm_code: po.incoterm_code, state: po.state }, { currency: 'USD', incoterm_code: 'DDP', state: 'draft' })
        const zeilen = await sql<{ name: string; qty: number; price_unit: number; typ: string }[]>`
          select l.name, l.qty::float as qty, l.price_unit::float as price_unit, pt.type::text as typ
          from purchase_order_lines l join product_variants pv on pv.id = l.variant_id
          join product_templates pt on pt.id = pv.template_id
          where l.order_id = ${po.id} order by l.sequence`
        assert.deepEqual([...zeilen], [
          { name: 'Keycap-Set PBT Dye-Sub (Prozesstest)', qty: 500, price_unit: 10.5, typ: 'goods' },
          { name: 'Keycap-Puller (Prozesstest)', qty: 500, price_unit: 0.4, typ: 'goods' },
        ])
        const raten = await sql<{ bezeichnung: string; anteil_pct: number; ausloeser: string }[]>`
          select bezeichnung, anteil_pct::float as anteil_pct, ausloeser from zahlplan_raten
          where purchase_order_id = ${po.id} order by sequence`
        assert.deepEqual([...raten], [
          { bezeichnung: 'Anzahlung 30 %', anteil_pct: 30, ausloeser: 'bestellung' },
          { bezeichnung: 'Rest 70 %', anteil_pct: 70, ausloeser: 'verschiffung' },
        ])
        const [{ preise }] = await sql<{ preise: number }[]>`
          select count(*)::int as preise from vendor_prices where vendor_id = ${ctx.usLieferantId} and angebot_staffel_id is not null`
        assert.equal(preise, 2, 'Lieferantenpreise aus den Staffeln')

        // Bestätigen und Ware vollständig einbuchen → das Projekt schließt sich selbst.
        await sql`select confirm_purchase_order(${po.id}, 'prozesstest')`
        const [eingang] = await sql<{ id: string }[]>`
          select id from stock_pickings where origin_model = 'purchase_order' and origin_id = ${po.id} and state not in ('done', 'cancel')`
        await sql`select picking_validate(${eingang.id}, '{}'::jsonb, false)`
        const [ep] = await sql<{ status: string }[]>`select status::text as status from einkaufsprojekte where id = ${id}`
        assert.equal(ep.status, 'abgeschlossen')
      },
    },
    {
      name: 'Angebot liegt schon vor: Betriebsausstattung direkt bestellen, von Hand abschließen',
      pfad: ['anlegen', 'entscheiden', 'bestellen', 'abschliessen'],
      eingaben: {
        anlegen: {
          titel: 'Packtische (Prozesstest)',
          art: 'betriebsausstattung',
          positionen: [{ bezeichnung: 'Packtisch 160 cm (Prozesstest)', menge: 2, zielpreis_eur: 400 }],
        },
        entscheiden: async (ctx, sql) => {
          const [tisch] = await positionen(sql, projektId(ctx))
          const r = await aktion('einkauf.angebot_erfassen', projektId(ctx), {
            partner_id: ctx.lieferantId,
            waehrung: 'EUR',
            incoterm_code: 'DAP',
            anzahlung_pct: 100,
            staffeln: [{ position_id: tisch.id, ab_menge: 1, preis: 389 }],
          })
          return { angebot_id: r.daten!.angebot_id }
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [z] = await sql<{ typ: string; raten: number }[]>`
          select pt.type::text as typ,
                 (select count(*)::int from zahlplan_raten r where r.purchase_order_id = po.id and r.anteil_pct = 100) as raten
          from purchase_orders po join purchase_order_lines l on l.order_id = po.id
          join product_variants pv on pv.id = l.variant_id join product_templates pt on pt.id = pv.template_id
          where po.einkaufsprojekt_id = ${id}`
        assert.deepEqual(z, { typ: 'service', raten: 1 }, 'Betriebsausstattung kommt nicht ins Lager; Vorkasse als eine Rate')
      },
    },
    {
      name: 'Musterpflicht: ohne Golden Sample keine Bestellung, nachbessern, freigeben, bestellen mit Werkzeug',
      pfad: ['anlegen', 'entscheiden', 'bemusterung', 'bestellen'],
      eingaben: {
        anlegen: {
          titel: 'Gehäuse Alu CNC (Prozesstest)',
          art: 'neuteil',
          muster_pflicht: true,
          positionen: [{ bezeichnung: 'Gehäuse Alu CNC (Prozesstest)', menge: 200, zielpreis_eur: 30, gewicht_g: 350, hs_code: '7616' }],
        },
        entscheiden: async (ctx, sql) => {
          const [gehaeuse] = await positionen(sql, projektId(ctx))
          const r = await aktion('einkauf.angebot_erfassen', projektId(ctx), {
            partner_id: ctx.cnLieferantId,
            waehrung: 'CNY',
            incoterm_code: 'FOB',
            werkzeugkosten: 1500,
            musterkosten: 300,
            staffeln: [{ position_id: gehaeuse.id, ab_menge: 100, preis: 180 }],
          })
          return { angebot_id: r.daten!.angebot_id }
        },
      },
      ereignisse: {
        // Der Teilprozess: Muster-Runden am Projekt, bis das Golden Sample frei ist.
        bemusterung: async (ctx) => {
          const id = projektId(ctx)
          await assert.rejects(
            aktion('einkauf.projekt_bestellen', id, {}),
            /Musterpflicht: ohne freigegebenes Golden Sample von Dongguan Keycap Co\. \(Prozesstest\) wird nicht bestellt/,
          )
          const erste = await aktion('einkauf.muster_anfordern', undefined, {
            projekt_id: id,
            partner_id: ctx.cnLieferantId,
            bezeichnung: 'Erstmuster Gehäuse',
            revision: 'A',
          })
          const zurueck = await aktion('einkauf.muster_bewerten', erste.recordId, { ergebnis: 'nachbessern', bewertung: 'Kanten nicht entgratet' })
          const zweite = String(zurueck.daten!.naechste_runde_id)
          await aktion('einkauf.muster_erhalten', zweite, {})
          await aktion('einkauf.muster_bewerten', zweite, { ergebnis: 'freigeben', golden: true, note: 4 })
        },
      },
      pruefen: async (sql, _ctx, id) => {
        const runden = await sql<{ runde: number; revision: string; status: string; golden: boolean; kosten: number | null }[]>`
          select runde, revision, status::text as status, golden, kosten::float as kosten
          from bemusterungen where projekt_id = ${id} order by runde`
        assert.deepEqual(runden.map((r) => ({ ...r })), [
          { runde: 1, revision: 'A', status: 'nachbessern', golden: false, kosten: 300 },
          { runde: 2, revision: 'B', status: 'freigegeben', golden: true, kosten: null },
        ], 'Musterkosten der ersten Runde aus dem Angebot, Revision B für die Nachbesserung')
        const [wz] = await sql<{ status: string; kosten: number; waehrung: string; eigentuemer: string; zeile: string }[]>`
          select w.status::text as status, w.kosten::float as kosten, w.waehrung, w.eigentuemer, l.name as zeile
          from werkzeuge w join purchase_order_lines l on l.id = w.purchase_order_line_id
          where w.einkaufsprojekt_id = ${id}`
        assert.equal(wz.zeile.startsWith('Werkzeugkosten laut Angebot'), true)
        assert.deepEqual(
          { status: wz.status, kosten: wz.kosten, waehrung: wz.waehrung, eigentuemer: wz.eigentuemer },
          { status: 'in_auftrag', kosten: 1500, waehrung: 'CNY', eigentuemer: 'wir' },
          'das bezahlte Werkzeug ist ein Datensatz am Lieferanten',
        )
      },
    },
    {
      name: 'Abbrechen',
      pfad: ['anlegen', 'abbrechen'],
      eingaben: {
        anlegen: { titel: 'Doch nicht (Prozesstest)', positionen: [{ bezeichnung: 'Foam-Einlage', menge: 1000 }] },
        abbrechen: { grund: 'Bedarf entfällt' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [ep] = await sql<{ status: string; abbruch_grund: string }[]>`
          select status::text as status, abbruch_grund from einkaufsprojekte where id = ${id}`
        assert.deepEqual(ep, { status: 'abgebrochen', abbruch_grund: 'Bedarf entfällt' })
      },
    },
  ],
}
