/**
 * Zulauf-Sendungsverfolgung über 17TRACK (0112, Entscheidungslog 2026-10-15)
 * gegen die echte Datenbank mit der 17TRACK-Attrappe:
 *  - Tracking-Nummer an der Bestellung → Zeile „angemeldet", Job eingereiht;
 *    der Job meldet an und holt den ersten Stand (Protokoll am Beleg);
 *  - stündlicher Abruf respektiert den Sechs-Stunden-Abstand;
 *  - Webhook stellt zu: Endzustand, nicht mehr aktiv, „zuletzt abgefragt"
 *    nennt die Quelle;
 *  - geänderte Nummer legt die alte still; nicht erkennbarer Carrier wird
 *    „nicht verfolgbar" mit Grund;
 *  - „Jetzt abfragen" als Registry-Aktion; Eingangssendung mit AWB;
 *  - ohne angebundenen Dienst: ehrlich „nicht verfolgbar", kein Job.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { runDueJobs } from '../../src/modules/integrationen/jobs.ts'
import { verfolgungAbrufen, webhookVerarbeiten } from '../../src/modules/versand/zulauf-verfolgung.ts'
import { webhookSignaturPruefen } from '../../src/modules/versand/track17.ts'
import { fakeEintrag, fakeStandSetzen } from '../../src/modules/versand/track17-fake.ts'

const DATENBANK = 'erp_zulauf_verfolgung_check'
const ADMIN = { name: 'zulauf-test', role: 'admin' as const }
let h: Harness
let poId = ''

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

const KOPF = { priority: false, receipt_reminder_email: false, reminder_date_before_receipt: 1 }
/** „JJD 0146 0000 3000 1234 5“ ohne Leerzeichen — letzte Stelle 5 = unterwegs (Attrappe). */
const NR = 'JJD01460000300012345'

before(async () => {
  h = await harnessStart(DATENBANK)
  const sql = h.sql
  const [v] = await sql<{ id: string }[]>`
    insert into partners (name, is_vendor, is_company, country_code) values ('Zulauf Lieferant', true, true, 'CN') returning id`
  const r = await aktion('einkauf.bestellung_anlegen', undefined, { vendor_id: v.id })
  assert.ok(r.recordId)
  poId = r.recordId
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const zeile = async (modell: string, recordId: string) =>
  h.sql<
    {
      id: string
      nummer: string
      carrier_code: number | null
      status: string
      aktiv: boolean
      registriert_am: string | null
      registrierung_fehler: string | null
      zuletzt_abgefragt_am: string | null
      zuletzt_abgefragt_via: string | null
      zugestellt_am: string | null
      letztes_ereignis: { text: string; ort: string | null } | null
      ereignisse: unknown[]
    }[]
  >`select id, nummer, carrier_code, status, aktiv, registriert_am::text, registrierung_fehler,
           zuletzt_abgefragt_am::text, zuletzt_abgefragt_via, zugestellt_am::text, letztes_ereignis, ereignisse
     from sendungsverfolgung where modell = ${modell} and record_id = ${recordId} order by created_at`

const protokoll = async (modell: string, recordId: string) =>
  h.sql<{ kind: string; message: string; actor: string }[]>`
    select kind, message, actor from audit_log where model = ${modell} and record_id = ${recordId} order by created_at`

describe('Zulauf-Sendungsverfolgung (17TRACK)', () => {
  test('Tracking-Nummer an der Bestellung → angemeldet, Job holt den ersten Stand', async () => {
    const sql = h.sql
    await aktion('einkauf.kopf_aendern', poId, { ...KOPF, carrier: 'DHL', tracking_nummer: 'JJD 0146 0000 3000 1234 5' })
    let [v] = await zeile('purchase_order', poId)
    assert.equal(v.nummer, NR, 'Leerzeichen werden entfernt')
    assert.equal(v.carrier_code, 7041)
    assert.equal(v.status, 'registriert')
    assert.equal(v.aktiv, true)
    assert.equal(v.registriert_am, null)
    const [job] = await sql<{ status: string; payload: { verfolgung_id: string } }[]>`
      select status, payload from integration_jobs where kind = 'track17_registrieren' and dedupe_key = ${`track17:${v.id}`}`
    assert.equal(job?.status, 'pending')
    assert.equal(job.payload.verfolgung_id, v.id)

    const lauf = await runDueJobs()
    assert.equal(lauf.failed, 0)
    ;[v] = await zeile('purchase_order', poId)
    assert.ok(v.registriert_am, 'angemeldet')
    assert.equal(v.status, 'unterwegs')
    assert.equal(v.zuletzt_abgefragt_via, 'registrierung')
    assert.ok(v.zuletzt_abgefragt_am)
    assert.equal(v.letztes_ereignis?.text, 'Sendung im Paketzentrum')
    assert.equal(v.letztes_ereignis?.ort, 'Leipzig')
    assert.equal(v.ereignisse.length, 2)
    const log = await protokoll('purchase_order', poId)
    assert.ok(log.some((l) => l.actor === 'track17' && /angemeldet — Unterwegs/.test(l.message)), JSON.stringify(log))
    assert.ok(log.some((l) => l.actor === 'track17' && new RegExp(`Sendung DHL Paket ${NR}: Unterwegs`).test(l.message)))

    // Gleiche Nummer erneut speichern: keine zweite Zeile, kein zweiter Job.
    await aktion('einkauf.kopf_aendern', poId, { ...KOPF, carrier: 'DHL', tracking_nummer: NR })
    assert.equal((await zeile('purchase_order', poId)).length, 1)
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from integration_jobs where kind = 'track17_registrieren'`
    assert.equal(Number(n), 1)
  })

  test('stündlicher Abruf: erst nach sechs Stunden wieder, dann „abruf"', async () => {
    const sql = h.sql
    assert.deepEqual(await verfolgungAbrufen(), { checked: 0, updated: 0, nachgemeldet: 0 })
    await sql`update sendungsverfolgung set zuletzt_abgefragt_am = now() - interval '7 hours' where record_id = ${poId}`
    const r = await verfolgungAbrufen()
    assert.equal(r.checked, 1)
    assert.equal(r.updated, 0, 'unverändert — kein neuer Protokolleintrag')
    const [v] = await zeile('purchase_order', poId)
    assert.equal(v.zuletzt_abgefragt_via, 'abruf')
  })

  test('Webhook: zugestellt → Endzustand, nicht mehr aktiv, Signatur geprüft', async () => {
    const nummer = NR
    fakeStandSetzen(nummer, { status: 'Delivered', sub_status: 'Delivered_Other', text: 'Zugestellt', ort: 'Berlin', zeit: '2026-10-15T09:30:00+02:00' })
    const payload = { event: 'TRACKING_UPDATED', data: fakeEintrag(nummer, 7041) }
    const roh = JSON.stringify(payload)
    const { createHash } = await import('node:crypto')
    const sign = createHash('sha256').update(`${roh}/fake-17track-key`).digest('hex')
    assert.equal(webhookSignaturPruefen(roh, sign), true)
    assert.equal(webhookSignaturPruefen(roh, sign.replace(/^./, 'f')), false)
    assert.equal(webhookSignaturPruefen(roh, null), false)

    assert.equal(await webhookVerarbeiten(payload), '1 Sendung(en) aktualisiert')
    const [v] = await zeile('purchase_order', poId)
    assert.equal(v.status, 'zugestellt')
    assert.equal(v.aktiv, false)
    assert.equal(v.zuletzt_abgefragt_via, 'webhook')
    assert.ok(v.zugestellt_am)
    const log = await protokoll('purchase_order', poId)
    assert.ok(log.some((l) => l.kind === 'state' && /Zugestellt — Berlin, 15.10. 09:30/.test(l.message)))

    assert.equal(await webhookVerarbeiten({ event: 'TRACKING_UPDATED', data: fakeEintrag('UNBEKANNT1', null) }), '1 Nummer(n) unbekannt — ignoriert')
    assert.equal(await webhookVerarbeiten({ event: 'TRACKING_UPDATED', data: {} }), 'ohne Sendungsnummer — ignoriert')
  })

  test('neue Nummer legt die alte still; unbekannter Carrier wird „nicht verfolgbar"', async () => {
    await aktion('einkauf.kopf_aendern', poId, { ...KOPF, carrier: 'Spedition Müller', tracking_nummer: 'XX-4711' })
    let zeilen = await zeile('purchase_order', poId)
    assert.equal(zeilen.length, 2)
    assert.equal(zeilen[0].aktiv, false)
    assert.equal(zeilen[1].nummer, 'XX-4711')
    assert.equal(zeilen[1].carrier_code, null, 'unbekannter Carrier → automatisch erkennen')
    const lauf = await runDueJobs()
    assert.equal(lauf.failed, 0)
    zeilen = await zeile('purchase_order', poId)
    assert.equal(zeilen[1].status, 'nicht_verfolgbar')
    assert.equal(zeilen[1].aktiv, false)
    assert.match(zeilen[1].registrierung_fehler ?? '', /Carrier nicht erkennbar/)
    const log = await protokoll('purchase_order', poId)
    assert.ok(log.some((l) => l.kind === 'error' && /nicht verfolgbar: Carrier nicht erkennbar/.test(l.message)))

    // Ohne Nummer: alles still, keine Zeile mehr aktiv.
    await aktion('einkauf.kopf_aendern', poId, { ...KOPF })
    assert.ok((await zeile('purchase_order', poId)).every((z) => !z.aktiv))
  })

  test('„Jetzt abfragen" meldet an und liefert den Stand als Text', async () => {
    await assert.rejects(aktion('einkauf.zulauf_verfolgen', poId), /Keine Sendungsnummer/)
    await aktion('einkauf.kopf_aendern', poId, { ...KOPF, carrier: 'DHL Express', tracking_nummer: '1234567897' })
    const r = await aktion('einkauf.zulauf_verfolgen', poId)
    assert.match(r.text ?? '', /^1234567897 angemeldet — Zugestellt — Berlin, 14.10. 22:10: Zugestellt \(gerade abgefragt\)\.$/)
    const aktive = (await zeile('purchase_order', poId)).filter((z) => z.nummer === '1234567897')
    assert.equal(aktive.length, 1)
    assert.equal(aktive[0].status, 'zugestellt')
    assert.equal(aktive[0].carrier_code, 100001)
    // Zweiter Klick: schon angemeldet → nur abfragen, Quelle „manuell".
    const r2 = await aktion('einkauf.zulauf_verfolgen', poId)
    assert.match(r2.text ?? '', /Zugestellt .*\(gerade abgefragt\)/)
    const [v] = (await zeile('purchase_order', poId)).filter((z) => z.nummer === '1234567897')
    assert.equal(v.zuletzt_abgefragt_via, 'manuell')
  })

  test('Eingangssendung: AWB wird verfolgt, Änderung folgt dem gespeicherten Stand', async () => {
    const r = await aktion('einkauf.sendung_anlegen', undefined, { modus: 'luft', traeger: 'DHL Express', hbl_awb: '160-1234 5672' })
    assert.ok(r.recordId)
    let [v] = await zeile('eingangs_sendung', r.recordId)
    assert.equal(v.nummer, '160-12345672')
    assert.equal(v.carrier_code, 100001)
    await runDueJobs()
    ;[v] = await zeile('eingangs_sendung', r.recordId)
    assert.equal(v.status, 'unterwegs')
    await aktion('einkauf.sendung_aendern', r.recordId, { hbl_awb: '160-12345676' })
    const zeilen = await zeile('eingangs_sendung', r.recordId)
    assert.deepEqual(zeilen.map((z) => [z.nummer, z.aktiv]), [['160-12345672', false], ['160-12345676', true]])
    const sv = await aktion('einkauf.sendung_verfolgen', r.recordId)
    assert.match(sv.text ?? '', /160-12345676 angemeldet — In Zustellung/)
  })

  test('ohne angebundenen Dienst: „nicht verfolgbar" mit Grund, kein Job', async () => {
    const sql = h.sql
    const [v] = await sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company, country_code) values ('Zulauf Lieferant 2', true, true, 'DE') returning id`
    const po = await aktion('einkauf.bestellung_anlegen', undefined, { vendor_id: v.id })
    const fake = process.env.TRACK17_FAKE
    process.env.TRACK17_FAKE = '0'
    try {
      await aktion('einkauf.kopf_aendern', po.recordId!, { ...KOPF, carrier: 'DHL', tracking_nummer: '00340434000000000001' })
      await assert.rejects(aktion('einkauf.zulauf_verfolgen', po.recordId!), /17TRACK ist nicht angebunden/)
    } finally {
      process.env.TRACK17_FAKE = fake
    }
    const [z] = await zeile('purchase_order', po.recordId!)
    assert.equal(z.status, 'nicht_verfolgbar')
    assert.equal(z.aktiv, false)
    assert.match(z.registrierung_fehler ?? '', /nicht angebunden/)
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from integration_jobs where kind = 'track17_registrieren' and payload ->> 'verfolgung_id' = ${z.id}`
    assert.equal(Number(n), 0)
    // Dienst wieder da, Nummer erneut gespeichert: neue Chance.
    await aktion('einkauf.kopf_aendern', po.recordId!, { ...KOPF, carrier: 'DHL', tracking_nummer: '00340434000000000001' })
    const [z2] = await zeile('purchase_order', po.recordId!)
    assert.equal(z2.status, 'registriert')
    assert.equal(z2.aktiv, true)
    assert.equal(z2.registrierung_fehler, null)
  })
})
