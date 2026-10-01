import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { ProzessFixture } from './typen.ts'

/**
 * Bemusterung (0107): je Muster-Runde ein Beleg. Drei Läufe an einem
 * Einkaufsprojekt mit Musterpflicht — anfordern, Eingang erfassen, als
 * Golden Sample freigeben; nachbessern (die nächste Runde startet von
 * selbst, mit nächster Revision); ablehnen, bevor das Muster da ist.
 * Der Weg des PROJEKTS durch den Teilprozess (ohne Golden Sample keine
 * Bestellung) steht in fixtures/einkaufsprojekt.ts.
 */

const NUTZER = { name: 'prozesstest', role: 'admin' as const }

async function aktion(name: string, recordId: string | undefined, parameter: Record<string, unknown>) {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  return aktionAusfuehrenGeprueft(name, { recordId, parameter }, NUTZER)
}

async function lieferant(sql: Sql, name: string, email: string): Promise<string> {
  const [da] = await sql<{ id: string }[]>`select id from partners where name = ${name} limit 1`
  if (da) return da.id
  const [p] = await sql<{ id: string }[]>`
    insert into partners (name, is_vendor, is_company, email, sprache, country_code, standard_waehrung)
    values (${name}, true, true, ${email}, 'en', 'CN', 'USD') returning id`
  return p.id
}

const PROJEKT = 'Gehäusedeckel bemustern (Prozesstest)'

export const BEMUSTERUNG_FIXTURE: ProzessFixture = {
  prozess: 'bemusterung',
  benoetigt: ['basis'],
  aufbauen: async (sql, ctx) => {
    ctx.musterLieferantId = await lieferant(sql, 'Shenzhen Mold Works (Prozesstest)', 'sales@moldworks-test.cn')
    const [da] = await sql<{ id: string }[]>`select id from einkaufsprojekte where titel = ${PROJEKT} limit 1`
    ctx.musterProjektId =
      da?.id ??
      (
        await aktion('einkauf.projekt_anlegen', undefined, {
          titel: PROJEKT,
          art: 'muster',
          muster_pflicht: true,
          positionen: [{ bezeichnung: 'Gehäusedeckel ABS (Prozesstest)', menge: 1000 }],
        })
      ).recordId!
  },
  laeufe: [
    {
      name: 'Muster anfordern, Eingang erfassen, als Golden Sample freigeben',
      pfad: ['anfordern', 'erhalten', 'freigeben'],
      eingaben: {
        anfordern: (ctx) => ({
          projekt_id: ctx.musterProjektId,
          partner_id: ctx.musterLieferantId,
          bezeichnung: 'Farbmuster Deckel',
          revision: 'A',
          kosten: 85,
          tracking: 'https://track.example/SF123456',
        }),
        erhalten: { erhalten_am: '2026-10-01' },
        freigeben: { note: 5, bewertung: 'Farbe und Passung in Ordnung' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [b] = await sql<{ status: string; golden: boolean; erhalten_am: string; waehrung: string; bewertet_von: string }[]>`
          select status::text as status, golden, erhalten_am::text as erhalten_am, waehrung, bewertet_von
          from bemusterungen where id = ${id}`
        assert.deepEqual({ ...b }, {
          status: 'freigegeben',
          golden: true,
          erhalten_am: '2026-10-01',
          waehrung: 'USD',
          bewertet_von: 'prozesstest',
        }, 'Golden Sample in der Standardwährung des Lieferanten')
      },
    },
    {
      name: 'Nachbessern lassen: die nächste Runde startet von selbst',
      pfad: ['anfordern', 'erhalten', 'nachbessern'],
      eingaben: {
        anfordern: (ctx) => ({ projekt_id: ctx.musterProjektId, partner_id: ctx.musterLieferantId, bezeichnung: 'Farbmuster Deckel' }),
        nachbessern: { bewertung: 'Farbe zu hell, Pantone 7621C treffen', naechste_revision: 'C' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [alt] = await sql<{ runde: number; status: string }[]>`
          select runde, status::text as status from bemusterungen where id = ${id}`
        assert.equal(alt.status, 'nachbessern')
        const [neu] = await sql<{ runde: number; revision: string; status: string; notiz: string }[]>`
          select runde, revision, status::text as status, notiz from bemusterungen where vorgaenger_id = ${id}`
        assert.deepEqual(
          { runde: neu.runde, revision: neu.revision, status: neu.status },
          { runde: alt.runde + 1, revision: 'C', status: 'offen' },
        )
        assert.match(neu.notiz, /Pantone 7621C/)
      },
    },
    {
      name: 'Ablehnen, bevor das Muster da ist',
      pfad: ['anfordern', 'ablehnen'],
      eingaben: {
        anfordern: (ctx) => ({ projekt_id: ctx.musterProjektId, partner_id: ctx.lieferantId, bezeichnung: 'Zweitquelle' }),
        ablehnen: { bewertung: 'Lieferant kann das Material nicht beschaffen' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, id) => {
        const [b] = await sql<{ status: string; erhalten_am: string | null; golden: boolean }[]>`
          select status::text as status, erhalten_am::text as erhalten_am, golden from bemusterungen where id = ${id}`
        assert.deepEqual({ ...b }, { status: 'abgelehnt', erhalten_am: null, golden: false })
      },
    },
  ],
}
