import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'
import { bestandAuffuellen } from './basis.ts'
import { bestellungEinspeisen } from './shopify-versand.ts'

/**
 * Kundenrechnung (0115): die Rechnung entsteht mit der Lieferung — der
 * Prozess beginnt deshalb meist mitten drin (Beleg vorab über die
 * Buchungswege). Drei Läufe: Shop-Lieferung → Rechnung bezahlt → Storno
 * mit Gutschrift (Shop erstattet); Firmenkunde → Rechnung offen → Zahlung
 * über das Register; Automatik aus → Rechnung von Hand aus der Lieferung.
 */

const NUTZER = { name: 'prozesstest', role: 'admin' as const }
const RECHNUNG_EINST = { zahlungsziel_tage: 14, mahnfrist_tage: 7, kontenrahmen: 'SKR03', debitorenkonto: '10000', erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120' }

/** 0117: Vorgabe jeder Instanz ist der Probelauf — die Fixture prüft den Ernstfall und schaltet ausdrücklich scharf. */
async function rechnungModus(modus: 'aus' | 'test' | 'scharf'): Promise<void> {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  await aktionAusfuehrenGeprueft('einstellungen.rechnungen_setzen', { parameter: { modus, ...RECHNUNG_EINST } }, NUTZER)
}

/** Lieferung des Auftrags über den Torwächter buchen (wie „Buchen" im Lager). */
async function lieferungBuchen(sql: Sql, auftragId: string): Promise<string> {
  const [picking] = await sql<{ id: string }[]>`
    select p.id from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = ${auftragId} and p.state not in ('done', 'cancel')
    order by p.created_at limit 1`
  assert.ok(picking, 'offene Lieferung zum Auftrag')
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  await aktionAusfuehrenGeprueft(
    'lager.transfer_buchen',
    { recordId: picking.id, parameter: { mengen: {}, lose: {}, backorder: false } },
    NUTZER,
  )
  return picking.id
}

/** B2B-Auftrag für den Prozesstest-Kunden: 2 Ersatzteile, bestätigt. */
async function firmenauftrag(ctx: FixtureKontext): Promise<string> {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  const r = await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_mit_positionen',
    { parameter: { kunde: ctx.kundeId, positionen: [{ produkt: ctx.teilId, menge: 2, preis: 40 }] } },
    NUTZER,
  )
  assert.ok(r?.recordId)
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: r.recordId }, NUTZER)
  return r.recordId
}

async function rechnungZurLieferung(sql: Sql, pickingId: string): Promise<string | null> {
  const [k] = await sql<{ id: string }[]>`
    select id from kundenrechnungen where picking_id = ${pickingId} and art = 'rechnung' and status <> 'storniert'`
  return k?.id ?? null
}

export const KUNDENRECHNUNG_FIXTURE: ProzessFixture = {
  prozess: 'kundenrechnung',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Shop-Lieferung erzeugt die Rechnung (bezahlt), Storno im Shop → Gutschrift',
      beleg: async (ctx, sql) => {
        await rechnungModus('scharf')
        // Der Bestand ist mit anderen Fixtures geteilt — was dieser Lauf
        // liefert, wird vorher aufgefüllt, damit spätere Läufe ihn vorfinden.
        await bestandAuffuellen(sql, ctx.teilId, 16)
        await bestellungEinspeisen(ctx, sql)
        const pickingId = await lieferungBuchen(sql, ctx.p4AuftragId)
        const rechnungId = await rechnungZurLieferung(sql, pickingId)
        assert.ok(rechnungId, 'die gebuchte Lieferung erzeugt die Rechnung von selbst')
        const [k] = await sql<{ status: string; zahlungsart: string | null; brutto: number }[]>`
          select status::text as status, zahlungsart, brutto from kundenrechnungen where id = ${rechnungId}`
        assert.equal(k.status, 'bezahlt', 'Shop-Aufträge sind bezahlt')
        assert.ok(Number(k.brutto) > 0)
        return rechnungId
      },
      pfad: ['stornieren'],
      eingaben: { stornieren: { grund: 'Rücksendung, in Shopify erstattet' } },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, rechnungId) => {
        const [k] = await sql<{ status: string }[]>`select status::text as status from kundenrechnungen where id = ${rechnungId}`
        assert.equal(k.status, 'storniert')
        const [g] = await sql<{ status: string; brutto: number; nummer: string }[]>`
          select status::text as status, brutto, nummer from kundenrechnungen where storno_von_id = ${rechnungId}`
        assert.ok(g, 'die Gutschrift existiert')
        assert.match(g.nummer, /^GU-/)
        assert.equal(g.status, 'bezahlt', 'Shop-Erstattung läuft über Shopify — nichts offen')
        const [r] = await sql<{ brutto: number }[]>`select brutto from kundenrechnungen where id = ${rechnungId}`
        assert.equal(Number(g.brutto), Number(r.brutto), 'die volle Gutschrift hebt die Rechnung genau auf')
      },
    },
    {
      name: 'Firmenkunde: Rechnung offen mit Zahlungsziel, Zahlung über das Register',
      beleg: async (ctx, sql) => {
        await rechnungModus('scharf')
        const auftragId = await firmenauftrag(ctx)
        const pickingId = await lieferungBuchen(sql, auftragId)
        const rechnungId = await rechnungZurLieferung(sql, pickingId)
        assert.ok(rechnungId)
        const [k] = await sql<{ status: string; faellig: boolean; netto: number }[]>`
          select status::text as status, faellig_am >= current_date as faellig, netto from kundenrechnungen where id = ${rechnungId}`
        assert.equal(k.status, 'offen')
        assert.ok(k.faellig, 'Zahlungsziel liegt in der Zukunft')
        assert.equal(Number(k.netto), 80)
        return rechnungId
      },
      pfad: ['zahlen'],
      eingaben: {
        zahlen: async (_ctx, sql) => {
          const [konto] = await sql<{ id: string }[]>`
            insert into bankkonten (name, waehrung) values ('Prozesstest Konto', 'EUR') returning id`
          return { bankkonto_id: konto.id }
        },
      },
      pruefen: async (sql, _ctx, rechnungId) => {
        const [k] = await sql<{ status: string; offen: number }[]>`
          select status::text as status, kundenrechnung_offen(id) as offen from kundenrechnungen where id = ${rechnungId}`
        assert.equal(k.status, 'bezahlt')
        assert.equal(Number(k.offen), 0)
        const [z] = await sql<{ n: number }[]>`
          select count(*)::int as n from zahlungen where kundenrechnung_id = ${rechnungId} and richtung = 'ein' and storniert_am is null`
        assert.equal(z.n, 1, 'die Zahlung steht im Register')
      },
    },
    {
      name: 'Modus aus: Rechnung von Hand aus der Lieferung, dann bezahlt',
      // Der Anlage-Schritt hängt an der Lieferung (record_id in den Eingaben,
      // wie /api/aktion) — die Rechnung entsteht erst durch den Schritt.
      pfad: ['rechnung', 'zahlen'],
      eingaben: {
        rechnung: async (ctx, sql) => {
          const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
          await aktionAusfuehrenGeprueft(
            'einstellungen.rechnungen_setzen',
            { parameter: { modus: 'aus', zahlungsziel_tage: 30, mahnfrist_tage: 7, kontenrahmen: 'SKR03', debitorenkonto: '10000', erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120' } },
            NUTZER,
          )
          const auftragId = await firmenauftrag(ctx)
          const pickingId = await lieferungBuchen(sql, auftragId)
          assert.equal(await rechnungZurLieferung(sql, pickingId), null, 'ohne Automatik keine Rechnung')
          return { record_id: pickingId }
        },
        zahlen: { zahlungsart: 'bar' },
      },
      pruefen: async (sql, _ctx, rechnungId) => {
        const [k] = await sql<{ status: string; zahlungsart: string | null }[]>`
          select status::text as status, zahlungsart from kundenrechnungen where id = ${rechnungId}`
        assert.equal(k.status, 'bezahlt')
        assert.equal(k.zahlungsart, 'bar')
        // Wieder scharf — Staging und Folgeläufe erwarten echte Rechnungen (0117: Vorgabe wäre der Probelauf).
        const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
        await aktionAusfuehrenGeprueft(
          'einstellungen.rechnungen_setzen',
          { parameter: { modus: 'scharf', zahlungsziel_tage: 14, mahnfrist_tage: 7, kontenrahmen: 'SKR03', debitorenkonto: '10000', erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120' } },
          NUTZER,
        )
      },
    },
  ],
}
