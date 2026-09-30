/**
 * Einkauf, Stufe 2a (Migration 0093) gegen die echte Datenbank und die
 * Gmail-/Drive-Attrappen (GOOGLE_FAKE=1): Erstabgleich und idempotenter
 * Cursor-Abgleich, Zuordnung per Domain, Freemail-Adresse und
 * Bestellnummer, Gesendet = Ausgang, weitergeleitete Alt-Threads,
 * Anhänge über den Outbox-Job in die Ablage (ohne Doppel), menschliche
 * Zuordnung schlägt die Regel, erledigte Threads kommen bei Antwort zurück,
 * von Hand erfasste Alibaba-Nachrichten, Wiedervorlagen und der Rückfall
 * bei abgelaufenem Verlauf.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_einkauf_postfach_check'
const TINO = { name: 'tino', role: 'mitarbeiter' as const }
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }
const POSTFACH = 'einkauf@anvil.example'

let h: Harness
const ids: Record<string, string> = {}

type Fake = typeof import('../../src/modules/google/google-fake-gmail.ts')
let fake: Fake

before(async () => {
  process.env.GOOGLE_FAKE = '1'
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

async function jobsAbarbeiten() {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  return runDueJobs(50)
}

async function thread(gmailThreadId: string) {
  const [t] = await h.sql<
    {
      id: string
      partner_id: string | null
      purchase_order_id: string | null
      status: string
      anzahl: number
      letzte_richtung: string
      zugeordnet_durch: string | null
      betreff: string
    }[]
  >`select id, partner_id, purchase_order_id, status::text, anzahl, letzte_richtung::text,
           zugeordnet_durch::text, betreff
    from mail_threads where gmail_thread_id = ${gmailThreadId}`
  return t
}

describe('Einkauf Stufe 2a: Postfach lesen und zuordnen', () => {
  test('Vorbereitung: Lieferanten mit Domain bzw. Freemail-Adresse, Bestellung, Ablage', async () => {
    const [p] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company) values ('PCBWay', true, true) returning id`
    ids.pcbway = p.id
    const [p2] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company) values ('Foam Factory', true, true) returning id`
    ids.foam = p2.id
    const [p3] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company) values ('Keycap Werkstatt', true, true) returning id`
    ids.keycap = p3.id

    await aktionAusfuehrenGeprueft(
      'einkauf.lieferantendaten_setzen',
      { recordId: ids.pcbway, parameter: { mail_domains: ['pcbway.com'], sprache: 'en' } },
      TINO,
    )
    // Freemailer: die Domain allein wird abgewiesen, die volle Adresse gilt.
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.lieferantendaten_setzen', { recordId: ids.foam, parameter: { mail_domains: ['qq.com'] } }, TINO),
      /Freemailer/,
    )
    await aktionAusfuehrenGeprueft(
      'einkauf.lieferantendaten_setzen',
      { recordId: ids.foam, parameter: { mail_domains: ['foamsales@qq.com'], sprache: 'zh' } },
      TINO,
    )
    const po = await aktionAusfuehrenGeprueft('einkauf.bestellung_anlegen', { parameter: { vendor_id: ids.keycap } }, TINO)
    ids.po = po.recordId!
    const [{ number }] = await h.sql<{ number: string }[]>`select number from purchase_orders where id = ${ids.po}`
    ids.poNummer = number
    await aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, ADMIN)
  })

  test('Erstabgleich: Domain, Freemail-Adresse, Bestellnummer im Betreff, Unbekanntes bleibt offen', async () => {
    fake.fakeMailEinliefern({
      threadId: 't-pcb',
      von: 'Wei Li <wei@sales.pcbway.com>',
      betreff: 'Quote PCB rev C',
      text: 'Dear Tino, price 1.20 USD.',
      anhaenge: [{ name: 'Quote_2025.pdf', mime: 'application/pdf', bytes: Buffer.alloc(40_000, 1) }],
    })
    fake.fakeMailEinliefern({ threadId: 't-foam', von: '"Anna" <FoamSales@qq.com>', betreff: '样品', text: '你好' })
    fake.fakeMailEinliefern({
      threadId: 't-po',
      von: 'someone@random-keycaps.cn',
      betreff: `Re: Order ${ids.poNummer} artwork`,
      text: 'Proof attached',
      anhaenge: [
        { name: 'proof.ai', mime: 'application/postscript', bytes: Buffer.alloc(30_000, 2) },
        { name: 'logo.png', mime: 'image/png', bytes: Buffer.alloc(3_000, 3) },
      ],
    })
    fake.fakeMailEinliefern({ threadId: 't-neu', von: 'info@unbekannt.de', betreff: 'Newsletter', text: 'Hallo' })

    const r = await abgleichen()
    assert.equal(r.neu, 4)
    assert.equal(r.zugeordnet, 3)
    assert.equal(r.anhaenge, 2, 'das kleine Logo gilt als Signatur und wird nicht abgelegt')
    assert.equal(r.weiter, false)

    const pcb = await thread('t-pcb')
    assert.equal(pcb.partner_id, ids.pcbway, 'Subdomain sales.pcbway.com passt auf pcbway.com')
    assert.equal(pcb.zugeordnet_durch, 'regel')
    assert.equal(pcb.letzte_richtung, 'eingang')
    assert.equal((await thread('t-foam')).partner_id, ids.foam, 'Freemail über die volle Adresse')
    const poThread = await thread('t-po')
    assert.equal(poThread.purchase_order_id, ids.po)
    assert.equal(poThread.partner_id, ids.keycap, 'Bestellnummer bringt den Lieferanten mit')
    const neu = await thread('t-neu')
    assert.equal(neu.partner_id, null)
    assert.equal(neu.status, 'offen')

    const [stand] = await h.sql<{ value: { history_id: string; adresse: string } }[]>`
      select value from settings where key = 'einkauf_postfach'`
    assert.ok(stand.value.history_id)
    assert.equal(stand.value.adresse, POSTFACH)
  })

  test('zweiter Lauf ohne Neues übernimmt nichts doppelt', async () => {
    const r = await abgleichen()
    assert.equal(r.neu, 0)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from mail_nachrichten`
    assert.equal(n, 4)
  })

  test('Anhänge: Job legt in den Lieferanten- bzw. Bestellordner ab, gleicher Inhalt wird verknüpft statt kopiert', async () => {
    await jobsAbarbeiten()
    const doks = await h.sql<{ name: string; quelle: string; art: string; partner_id: string | null; drive_file_id: string }[]>`
      select name, quelle::text, art::text, partner_id, drive_file_id from dokumente order by lower(name)`
    assert.deepEqual(doks.map((d) => [d.name, d.quelle, d.art]), [
      ['proof.ai', 'mail', 'ai'],
      ['Quote_2025.pdf', 'mail', 'angebot'],
    ])
    const { fakeDatei } = await import('../../src/modules/google/google-fake.ts')
    const [poOrdner] = await h.sql<{ folder_id: string }[]>`
      select folder_id from drive_ordner where schluessel = ${`purchase_order:${ids.po}`}`
    assert.deepEqual(fakeDatei(doks[0].drive_file_id)?.parents, [poOrdner.folder_id])

    const verweise = await h.sql<{ modell: string }[]>`
      select v.modell from dokument_verweise v join dokumente d on d.id = v.dokument_id
      where d.name = 'proof.ai' order by v.modell`
    assert.deepEqual(verweise.map((v) => v.modell), ['mail_thread', 'partner', 'purchase_order'])

    // Der Lieferant schickt den Proof noch einmal (gleicher Inhalt) im selben Thread.
    fake.fakeMailEinliefern({
      threadId: 't-po',
      von: 'someone@random-keycaps.cn',
      betreff: `Re: Order ${ids.poNummer} artwork`,
      text: 'again',
      anhaenge: [{ name: 'proof (1).ai', mime: 'application/postscript', bytes: Buffer.alloc(30_000, 2) }],
    })
    await abgleichen()
    await jobsAbarbeiten()
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from dokumente where md5 is not null`
    assert.equal(n, 2, 'keine zweite Kopie in der Ablage')
    const offen = await h.sql`select 1 from mail_anhaenge where dokument_id is null and fehler is null`
    assert.equal(offen.length, 0)
  })

  test('Gesendet (aus Gmail) ist Ausgang; eine Antwort holt einen erledigten Thread zurück', async () => {
    const pcb = await thread('t-pcb')
    await aktionAusfuehrenGeprueft('einkauf.mail_status_setzen', { recordId: pcb.id, parameter: { status: 'erledigt' } }, TINO)

    fake.fakeMailEinliefern({ threadId: 't-pcb', von: POSTFACH, an: 'wei@sales.pcbway.com', betreff: 'Re: Quote PCB rev C', text: 'OK', labels: ['SENT'] })
    await abgleichen()
    let t = await thread('t-pcb')
    assert.equal(t.letzte_richtung, 'ausgang')
    assert.equal(t.status, 'erledigt', 'eigene Antwort öffnet nicht wieder')

    fake.fakeMailEinliefern({ threadId: 't-pcb', von: 'wei@sales.pcbway.com', betreff: 'Re: Quote PCB rev C', text: 'Thanks' })
    await abgleichen()
    t = await thread('t-pcb')
    assert.equal(t.status, 'offen', 'Antwort des Lieferanten holt den Thread zurück')
    assert.equal(t.anzahl, 3)
  })

  test('von uns begonnener Thread wird über den Empfänger zugeordnet; Entwürfe werden übersprungen', async () => {
    fake.fakeMailEinliefern({ threadId: 't-anfrage', von: POSTFACH, an: 'wei@pcbway.com', betreff: 'RFQ keyboard PCB', text: 'Please quote', labels: ['SENT'] })
    fake.fakeMailEinliefern({ threadId: 't-entwurf', von: POSTFACH, betreff: 'Entwurf', text: 'x', labels: ['DRAFT'] })
    const r = await abgleichen()
    assert.equal(r.uebersprungen, 1)
    assert.equal((await thread('t-anfrage')).partner_id, ids.pcbway)
    assert.equal(await thread('t-entwurf'), undefined)
  })

  test('weitergeleiteter Alt-Thread: ursprünglicher Absender, Datum und Betreff zählen', async () => {
    fake.fakeMailEinliefern({
      threadId: 't-fwd',
      von: 'Tino <tino@anvil.example>',
      betreff: 'WG: Foam samples',
      text:
        'zur Info\n\n-----Ursprüngliche Nachricht-----\nVon: Anna [mailto:foamsales@qq.com]\n' +
        'Gesendet: Montag, 3. März 2025 10:15\nAn: Tino\nBetreff: Foam samples\n\nSamples shipped via DHL.',
    })
    await abgleichen()
    const [n] = await h.sql<{ von: string; quelle: string; erfasst_von: string; betreff: string; datum: Date; text: string; richtung: string }[]>`
      select n.von, n.quelle, n.erfasst_von, n.betreff, n.datum, n.text, n.richtung::text
      from mail_nachrichten n join mail_threads t on t.id = n.thread_id where t.gmail_thread_id = 't-fwd'`
    assert.equal(n.quelle, 'weitergeleitet')
    assert.equal(n.von, 'foamsales@qq.com')
    assert.equal(n.erfasst_von, 'tino@anvil.example')
    assert.equal(n.betreff, 'Foam samples')
    assert.equal(n.richtung, 'eingang')
    assert.equal(n.datum.toISOString().slice(0, 10), '2025-03-03')
    assert.equal(n.text, 'Samples shipped via DHL.')
    assert.equal((await thread('t-fwd')).partner_id, ids.foam)
  })

  test('menschliche Zuordnung: Absender merken, Dateien ziehen aus dem Eingang um, die Regel überschreibt nicht', async () => {
    fake.fakeMailEinliefern({
      threadId: 't-mensch',
      von: 'sales@neuer-lieferant.cn',
      betreff: 'Catalogue',
      text: 'see attachment',
      anhaenge: [{ name: 'catalogue.pdf', mime: 'application/pdf', bytes: Buffer.alloc(25_000, 9) }],
    })
    await abgleichen()
    await jobsAbarbeiten()
    const t = await thread('t-mensch')
    assert.equal(t.partner_id, null)
    const [dok] = await h.sql<{ drive_file_id: string }[]>`select drive_file_id from dokumente where name = 'catalogue.pdf'`
    const { fakeDatei } = await import('../../src/modules/google/google-fake.ts')
    const [eingang] = await h.sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = 'wurzel:eingang'`
    assert.deepEqual(fakeDatei(dok.drive_file_id)?.parents, [eingang.folder_id], 'ohne Zuordnung in den Eingang')

    // Bestellung gehört einem anderen Lieferanten → abgewiesen.
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.mail_zuordnen', { recordId: t.id, parameter: { partner_id: ids.foam, purchase_order_id: ids.po } }, TINO),
      /anderen Lieferanten/,
    )
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.mail_zuordnen',
      { recordId: t.id, parameter: { partner_id: ids.keycap, absender_merken: true } },
      TINO,
    )
    assert.match(r.text ?? '', /neuer-lieferant\.cn wird künftig automatisch zugeordnet/)
    assert.match(r.text ?? '', /1 Datei\(en\) in den Lieferantenordner verschoben/)
    const [ordner] = await h.sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = ${`partner:${ids.keycap}`}`
    assert.deepEqual(fakeDatei(dok.drive_file_id)?.parents, [ordner.folder_id])
    const [p] = await h.sql<{ mail_domains: string[] }[]>`select mail_domains from partners where id = ${ids.keycap}`
    assert.deepEqual(p.mail_domains, ['neuer-lieferant.cn'])

    // Regel läuft erneut (neue Mail im Thread) — die menschliche Zuordnung bleibt.
    fake.fakeMailEinliefern({ threadId: 't-mensch', von: 'wei@pcbway.com', betreff: 'Re: Catalogue', text: 'cc' })
    await abgleichen()
    const nachher = await thread('t-mensch')
    assert.equal(nachher.partner_id, ids.keycap)
    assert.equal(nachher.zugeordnet_durch, 'mensch')
  })

  test('Alibaba-Chat von Hand erfassen: neuer Thread am Lieferanten, dann Antwort im selben Thread', async () => {
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.nachricht_erfassen',
      { parameter: { kanal: 'alibaba', richtung: 'eingang', partner_id: ids.foam, betreff: 'Foam 40x30', text: 'MOQ 1000, 0.35 USD' } },
      TINO,
    )
    ids.alibaba = r.recordId!
    await aktionAusfuehrenGeprueft(
      'einkauf.nachricht_erfassen',
      { parameter: { kanal: 'alibaba', richtung: 'ausgang', thread_id: ids.alibaba, text: 'Can you do 500?' } },
      TINO,
    )
    const [t] = await h.sql<{ kanal: string; partner_id: string; anzahl: number; letzte_richtung: string; zugeordnet_durch: string }[]>`
      select kanal::text, partner_id, anzahl, letzte_richtung::text, zugeordnet_durch::text from mail_threads where id = ${ids.alibaba}`
    assert.deepEqual(t, { kanal: 'alibaba', partner_id: ids.foam, anzahl: 2, letzte_richtung: 'ausgang', zugeordnet_durch: 'mensch' })
    const quellen = await h.sql<{ quelle: string; erfasst_von: string }[]>`
      select quelle, erfasst_von from mail_nachrichten where thread_id = ${ids.alibaba}`
    assert.ok(quellen.every((q) => q.quelle === 'manuell' && q.erfasst_von === 'tino'))
  })

  test('Wiedervorlage anlegen und erledigen; unbekannter Beleg wird abgewiesen', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.wiedervorlage_anlegen',
        { parameter: { modell: 'purchase_order', record_id: ids.pcbway, faellig_am: '2026-10-07', grund: 'x' } },
        TINO,
      ),
      /existiert nicht/,
    )
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.wiedervorlage_anlegen',
      { parameter: { modell: 'mail_thread', record_id: ids.alibaba, faellig_am: '2026-10-07', grund: 'Antwort zu 500 Stück erwartet' } },
      TINO,
    )
    await aktionAusfuehrenGeprueft('einkauf.wiedervorlage_erledigen', { parameter: { wiedervorlage_id: r.recordId! } }, TINO)
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.wiedervorlage_erledigen', { parameter: { wiedervorlage_id: r.recordId! } }, TINO),
      /schon erledigt/,
    )
    const [w] = await h.sql<{ erledigt_von: string }[]>`select erledigt_von from wiedervorlagen where id = ${r.recordId!}`
    assert.equal(w.erledigt_von, 'tino')
  })

  test('abgelaufener Verlauf: Rückfall auf die letzten 7 Tage, ohne Doppel; Abgleich von Hand nur für Admins', async () => {
    fake.fakeVerlaufVerfallen()
    fake.fakeMailEinliefern({ threadId: 't-spaet', von: 'wei@pcbway.com', betreff: 'Tracking', text: 'DHL 123' })
    await assert.rejects(aktionAusfuehrenGeprueft('integrationen.postfach_abgleichen', {}, TINO), /Administratoren/)
    const r = await aktionAusfuehrenGeprueft('integrationen.postfach_abgleichen', {}, ADMIN)
    assert.match(r.text ?? '', /1 neue Nachricht/)
    assert.match(r.text ?? '', /Verlauf war abgelaufen/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int - count(distinct gmail_message_id)::int as n from mail_nachrichten where gmail_message_id is not null`
    assert.equal(n, 0)
    assert.equal((await thread('t-spaet')).partner_id, ids.pcbway)
  })

  test('Zeitbudget: reicht es nicht, bleibt der Cursor stehen und der nächste Lauf macht weiter', async () => {
    const { postfachAbgleichen } = await import('../../src/modules/einkauf/postfach-abgleich.ts')
    const [vorher] = await h.sql<{ value: { history_id: string } }[]>`select value from settings where key = 'einkauf_postfach'`
    fake.fakeMailEinliefern({ threadId: 't-budget', von: 'wei@pcbway.com', betreff: 'A', text: '1' })
    fake.fakeMailEinliefern({ threadId: 't-budget', von: 'wei@pcbway.com', betreff: 'A', text: '2' })
    const r = await postfachAbgleichen(-1)
    assert.equal(r.weiter, true)
    assert.equal(r.neu, 0)
    const [mitte] = await h.sql<{ value: { history_id: string } }[]>`select value from settings where key = 'einkauf_postfach'`
    assert.equal(mitte.value.history_id, vorher.value.history_id)
    const r2 = await postfachAbgleichen()
    assert.equal(r2.neu, 2)
  })
})
