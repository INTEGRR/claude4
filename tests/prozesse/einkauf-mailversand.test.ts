/**
 * Einkauf, Stufe 2b (Migration 0094) gegen die echte Datenbank mit Gmail-,
 * Drive-Attrappe und KI_FAKE: Antwort im Thread mit In-Reply-To/References
 * und Vorlage in Lieferantensprache, offene Platzhalter halten das Senden
 * auf, Übersetzung per KI (Verbrauch protokolliert), der nächste Abgleich
 * übernimmt die gesendete Mail nicht doppelt, chinesische Eingänge werden
 * automatisch übersetzt, „Per E-Mail senden" an der Bestellung erzeugt
 * einen Entwurf mit Bestell-PDF, zu große Anhänge und Änderungen nach der
 * Freigabe werden abgewiesen.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_einkauf_mailversand_check'
const TINO = { name: 'tino', role: 'mitarbeiter' as const }
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }
const POSTFACH = 'einkauf@anvil.example'

let h: Harness
const ids: Record<string, string> = {}
type Fake = typeof import('../../src/modules/google/google-fake-gmail.ts')
let fake: Fake

before(async () => {
  process.env.GOOGLE_FAKE = '1'
  process.env.KI_FAKE = '1'
  process.env.EINKAUF_POSTFACH = POSTFACH
  h = await harnessStart(DATENBANK)
  fake = await import('../../src/modules/google/google-fake-gmail.ts')
  fake.fakeGmailLeeren()
  const { fakeDriveLeeren } = await import('../../src/modules/google/google-fake.ts')
  fakeDriveLeeren()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function abgleichen() {
  const { postfachAbgleichen } = await import('../../src/modules/einkauf/postfach-abgleich.ts')
  return postfachAbgleichen()
}

async function jobs() {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  for (let i = 0; i < 10; i++) if ((await runDueJobs(50)).ran === 0) break
}

async function entwurf(id: string) {
  const [e] = await h.sql<
    { status: string; an: string[]; betreff: string; text_de: string; text_ziel: string | null; sprache: string; anhang_dokument_ids: string[]; thread_id: string | null }[]
  >`select status::text, an, betreff, text_de, text_ziel, sprache, anhang_dokument_ids, thread_id from mail_entwuerfe where id = ${id}`
  return e
}

describe('Einkauf Stufe 2b: aus KRNL schreiben', () => {
  test('Vorbereitung: chinesischer Lieferant, Bestellung mit Position, Ablage', async () => {
    const [p] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company, email, sprache, country_code, mail_domains)
      values ('Dongguan Foam Ltd.', true, true, 'anna@foam.cn', 'zh', 'CN', '{foam.cn}') returning id`
    ids.foam = p.id
    const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await h.sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, type) values ('Foam-Einlage 40x30', ${stueck.id}, 'goods') returning id`
    await h.sql`select generate_variants(${tpl.id})`
    const [v] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
    ids.po = (await aktionAusfuehrenGeprueft('einkauf.bestellung_anlegen', { parameter: { vendor_id: ids.foam } }, TINO)).recordId!
    await aktionAusfuehrenGeprueft('einkauf.position_hinzufuegen', { recordId: ids.po, parameter: { variant_id: v.id, qty: 1000, price_unit: 0.35 } }, TINO)
    await aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, ADMIN)
  })

  test('Antwort im Thread: Empfänger, Re:-Betreff und Vorlage in Lieferantensprache; offene Platzhalter halten auf', async () => {
    fake.fakeMailEinliefern({ threadId: 'g-foam', von: 'Anna Wu <anna@foam.cn>', betreff: 'Foam samples', text: 'Samples shipped.', messageIdHeader: '<m1@foam.cn>' })
    await abgleichen()
    const [t] = await h.sql<{ id: string }[]>`select id from mail_threads where gmail_thread_id = 'g-foam'`
    ids.thread = t.id

    const r = await aktionAusfuehrenGeprueft(
      'einkauf.mail_entwurf_anlegen',
      { parameter: { thread_id: ids.thread, vorlage: 'liefertermin', antwort_erwartet_bis: '2026-10-09' } },
      TINO,
    )
    ids.antwort = r.recordId!
    assert.equal(r.link, `/einkauf/entwuerfe/${ids.antwort}`)
    const e = await entwurf(ids.antwort)
    assert.deepEqual(e.an, ['anna@foam.cn'])
    assert.equal(e.betreff, 'Re: Foam samples')
    assert.equal(e.sprache, 'zh')
    assert.match(e.text_de, /^Guten Tag Anna,/)
    assert.match(e.text_ziel ?? '', /^Anna，您好！/)
    // Thread ist dem Lieferanten zugeordnet, aber an keiner Bestellung → [bestellnummer] bleibt offen.
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.mail_freigeben', { recordId: ids.antwort }, TINO), /offene Platzhalter: \[bestellnummer\], \[liefertermin\]/)
  })

  test('Übersetzen per KI (Fake): Deutsch → Chinesisch, Verbrauch protokolliert', async () => {
    await aktionAusfuehrenGeprueft(
      'einkauf.mail_entwurf_aendern',
      { recordId: ids.antwort, parameter: { text_de: 'Hallo Anna,\nbitte Tracking-Nummer schicken.\nDanke, Tino' } },
      TINO,
    )
    await aktionAusfuehrenGeprueft('einkauf.mail_uebersetzen', { recordId: ids.antwort, parameter: { richtung: 'nach_ziel' } }, TINO)
    const e = await entwurf(ids.antwort)
    assert.equal(e.text_ziel, '[zh] Hallo Anna,\nbitte Tracking-Nummer schicken.\nDanke, Tino')
    const [k] = await h.sql<{ ebene: string; zweck: string; modell_bezug: string; record_id: string }[]>`
      select ebene, zweck, modell_bezug, record_id from ki_verbrauch order by created_at desc limit 1`
    assert.deepEqual(k, { ebene: 'uebersetzung', zweck: 'uebersetzung_entwurf', modell_bezug: 'mail_entwurf', record_id: ids.antwort })
  })

  test('Freigeben → gmail_senden: im Thread mit In-Reply-To/References, Nachricht, Wiedervorlage; kein Doppel beim Abgleich', async () => {
    await aktionAusfuehrenGeprueft('einkauf.mail_freigeben', { recordId: ids.antwort }, TINO)
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.mail_entwurf_aendern', { recordId: ids.antwort, parameter: { betreff: 'x' } }, TINO),
      /Nur Entwürfe/,
    )
    await jobs()
    const e = await entwurf(ids.antwort)
    assert.equal(e.status, 'gesendet')
    const gesendet = fake.fakeGesendet().at(-1)!
    assert.equal(gesendet.threadId, 'g-foam')
    assert.match(gesendet.raw, /\r\nIn-Reply-To: <m1@foam\.cn>\r\n/)
    assert.match(gesendet.raw, /\r\nReferences: <m1@foam\.cn>\r\n/)
    assert.match(gesendet.raw, /\r\nTo: anna@foam\.cn\r\n/)
    assert.match(gesendet.raw, new RegExp(`^From: .*<${POSTFACH}>\\r\\n`))

    const [t] = await h.sql<{ anzahl: number; letzte_richtung: string }[]>`
      select anzahl, letzte_richtung::text from mail_threads where id = ${ids.thread}`
    assert.deepEqual(t, { anzahl: 2, letzte_richtung: 'ausgang' })
    const [w] = await h.sql<{ faellig_am: string }[]>`
      select faellig_am::text from wiedervorlagen where record_id = ${ids.thread}`
    assert.equal(w.faellig_am, '2026-10-09')

    const r = await abgleichen()
    assert.equal(r.neu, 0, 'die gesendete Mail kennt der Abgleich schon')
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from mail_nachrichten where thread_id = ${ids.thread}`
    assert.equal(n, 2)
  })

  test('chinesischer Eingang wird automatisch übersetzt; englischer auf Knopfdruck', async () => {
    fake.fakeMailEinliefern({ threadId: 'g-foam', von: 'anna@foam.cn', betreff: 'Re: Foam samples', text: '您好，快递单号是 SF123456789。谢谢！' })
    fake.fakeMailEinliefern({ threadId: 'g-foam', von: 'anna@foam.cn', betreff: 'Re: Foam samples', text: 'Sorry, the correct tracking number is SF987654321.' })
    await abgleichen()
    await jobs()
    const nachrichten = await h.sql<{ id: string; sprache: string; text: string; text_de: string | null }[]>`
      select id, sprache, text, text_de from mail_nachrichten where thread_id = ${ids.thread} and richtung = 'eingang' order by datum, created_at`
    const zh = nachrichten.find((x) => x.sprache === 'zh')!
    const en = nachrichten.find((x) => x.text.startsWith('Sorry'))!
    assert.equal(en.sprache, 'en')
    assert.equal(en.text_de, null, 'Englisch wird nicht automatisch übersetzt')
    assert.equal(zh.text_de, '[de] 您好，快递单号是 SF123456789。谢谢！')
    const r = await aktionAusfuehrenGeprueft('einkauf.nachricht_uebersetzen', { parameter: { nachricht_id: en.id } }, TINO)
    assert.equal(r.recordId, ids.thread)
    const [n] = await h.sql<{ text_de: string }[]>`select text_de from mail_nachrichten where id = ${en.id}`
    assert.match(n.text_de, /^\[de\] Sorry/)
  })

  test('„Per E-Mail senden" an der Bestellung: Entwurf mit Bestell-PDF in der Ablage, gesendet mit Anhang', async () => {
    const r = await aktionAusfuehrenGeprueft('einkauf.email_senden', { recordId: ids.po }, TINO)
    assert.match(r.text ?? '', /Entwurf mit Bestell-PDF/)
    const e = await entwurf(r.recordId!)
    assert.equal(e.anhang_dokument_ids.length, 1)
    const [d] = await h.sql<{ name: string; art: string; mime: string; drive_file_id: string; groesse: number }[]>`
      select name, art::text, mime, drive_file_id, groesse::float as groesse from dokumente where id = ${e.anhang_dokument_ids[0]}`
    const [{ number }] = await h.sql<{ number: string }[]>`select number from purchase_orders where id = ${ids.po}`
    assert.equal(d.name, `${number}.pdf`)
    assert.equal(d.art, 'bestellung')
    const { fakeDatei } = await import('../../src/modules/google/google-fake.ts')
    assert.equal(fakeDatei(d.drive_file_id)?.bytes.subarray(0, 5).toString(), '%PDF-')
    const [ordner] = await h.sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = ${`purchase_order:${ids.po}`}`
    assert.deepEqual(fakeDatei(d.drive_file_id)?.parents, [ordner.folder_id])
    assert.match(e.betreff, new RegExp(`^采购订单 ${number}`))

    await aktionAusfuehrenGeprueft('einkauf.mail_freigeben', { recordId: r.recordId! }, TINO)
    await jobs()
    assert.equal((await entwurf(r.recordId!)).status, 'gesendet')
    const raw = fake.fakeGesendet().at(-1)!.raw
    assert.match(raw, new RegExp(`Content-Disposition: attachment; filename="${number}\\.pdf"`))
    const [{ state }] = await h.sql<{ state: string }[]>`select state::text from purchase_orders where id = ${ids.po}`
    assert.equal(state, 'draft', 'kein „sent" ohne Prozessschritt — die Bestellung behält ihren Platz im Ablauf')
  })

  test('zu große Anhänge und fehlende Empfänger werden vor dem Senden abgewiesen', async () => {
    const [gross] = await h.sql<{ id: string }[]>`
      insert into dokumente (drive_file_id, name, mime, groesse, art, quelle, partner_id)
      values ('fake-gross', 'mold.step', 'model/step', ${20 * 1024 * 1024}, 'step', 'manuell', ${ids.foam}) returning id`
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.mail_entwurf_anlegen',
      { parameter: { partner_id: ids.foam, sprache: 'en', betreff: 'Mold data', text_ziel: 'See attached.', anhang_dokument_ids: [gross.id] } },
      TINO,
    )
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.mail_freigeben', { recordId: r.recordId! }, TINO), /höchstens 18 MB/)
    await aktionAusfuehrenGeprueft('einkauf.mail_entwurf_aendern', { recordId: r.recordId!, parameter: { an: [], anhang_dokument_ids: [] } }, TINO)
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.mail_freigeben', { recordId: r.recordId! }, TINO), /mindestens einen Empfänger/)
  })
})
