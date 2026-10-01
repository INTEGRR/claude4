/**
 * Einkauf, Stufe 6 (Migration 0109) gegen die echte Datenbank mit Gmail-,
 * Drive-Attrappe und KI_FAKE: Jede eingehende Mail reiht den Job
 * ki_mail_triage ein (eigene Spur „ki"). Ist die KI-Ebene „Einkauf" aus oder
 * fehlt der Schlüssel, überspringt er sauber. Eingeschaltet legt der Agent
 * aus „Price for 1000 pcs is 0.85 USD, MOQ 500" den Vorschlag „Angebot
 * erfassen" mit Staffel und einen Antwort-Entwurf an — gesendet wird nichts
 * (Entwurf bleibt `entwurf`, kein gmail_senden-Job). PDFs liest der
 * Dokument-Leser (Text + Vorschlag), Excel ist nicht lesbar. Annehmen führt
 * die Aktion als der annehmende Mensch aus (Audit-Akteur = er), Verwerfen
 * führt nichts aus, ein gescheiterter Vorschlag lässt sich ändern und
 * erneut annehmen.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_einkauf_agent_check'
const TINO = { name: 'tino', role: 'mitarbeiter' as const }
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }
const FERTIGER = { name: 'fertiger', role: 'fertigung' as const }
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

/** Die allgemeine Spur (Anhänge ablegen, Übersetzen …) — läuft nie KI-Jobs. */
async function jobs() {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  for (let i = 0; i < 10; i++) if ((await runDueJobs(50)).ran === 0) break
}

/** Die KI-Spur (Cron ?task=ki). */
async function kiJobs() {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  let gelaufen = 0
  for (let i = 0; i < 10; i++) {
    const r = await runDueJobs(50, 40_000, 'ki')
    gelaufen += r.ran
    if (r.ran === 0) break
  }
  return gelaufen
}

async function jobZu(kind: string, schluessel: string, wert: string) {
  const [j] = await h.sql<{ status: string; last_result: string | null; last_error: string | null }[]>`
    select status::text, last_result, last_error from integration_jobs
    where kind = ${kind} and payload ->> ${schluessel} = ${wert}
    order by created_at desc limit 1`
  return j
}

async function nachrichtVon(gmailId: string) {
  const [n] = await h.sql<{ id: string; thread_id: string; ki_gesichtet_am: string | null }[]>`
    select id, thread_id, ki_gesichtet_am::text from mail_nachrichten where gmail_message_id = ${gmailId}`
  return n
}

describe('Einkauf Stufe 6: Agent — nur Entwürfe', () => {
  test('Vorbereitung: Lieferant mit Maildomain, Projekt mit Position, Ablage', async () => {
    const [p] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company, email, sprache, country_code, mail_domains)
      values ('Shenzhen PCB Ltd.', true, true, 'sales@pcb.example', 'en', 'CN', '{pcb.example}') returning id`
    ids.pcb = p.id
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.projekt_anlegen',
      { parameter: { titel: 'Hauptplatine', art: 'neuteil', positionen: [{ bezeichnung: 'Hauptplatine Rev. C', menge: 1000 }] } },
      TINO,
    )
    ids.projekt = r.recordId!
    const [pos] = await h.sql<{ id: string }[]>`select id from einkaufsprojekt_positionen where projekt_id = ${ids.projekt}`
    ids.position = pos.id
    const [ep] = await h.sql<{ nummer: string }[]>`select nummer from einkaufsprojekte where id = ${ids.projekt}`
    ids.nummer = ep.nummer
    await aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, ADMIN)
    const [s] = await h.sql<{ value: { aktiv: boolean } }[]>`select value from settings where key = 'ki_einkauf'`
    assert.equal(s.value.aktiv, false, 'die KI-Ebene „Einkauf" ist nach der Migration aus')
  })

  test('Ebene aus: jede eingehende Mail reiht den Job ein — er überspringt sauber, die allgemeine Spur lässt ihn liegen', async () => {
    const m = fake.fakeMailEinliefern({ threadId: 'g-pcb-1', von: 'Amy Li <amy@pcb.example>', betreff: `RFQ ${ids.nummer}`, text: 'We received your RFQ.' })
    await abgleichen()
    const n = await nachrichtVon(m.id)
    ids.nachricht0 = n.id
    await jobs()
    const wartet = await jobZu('ki_mail_triage', 'nachricht_id', n.id)
    assert.equal(wartet.status, 'pending', 'KI-Jobs laufen nur in ihrer eigenen Spur')

    assert.equal(await kiJobs(), 1)
    const j = await jobZu('ki_mail_triage', 'nachricht_id', n.id)
    assert.equal(j.status, 'done')
    assert.match(j.last_result ?? '', /^Übersprungen — KI-Ebene „Einkauf" ist aus/)
    const [{ v }] = await h.sql<{ v: number }[]>`select count(*)::int as v from ki_vorschlaege`
    assert.equal(v, 0)
    assert.equal((await nachrichtVon(m.id)).ki_gesichtet_am, null)
  })

  test('Ebene an, aber ohne Schlüssel und ohne Fake: übersprungen statt Fehlerschleife', async () => {
    await aktionAusfuehrenGeprueft('einstellungen.ki_einkauf_setzen', { parameter: { aktiv: true } }, ADMIN)
    await assert.rejects(
      aktionAusfuehrenGeprueft('einstellungen.ki_einkauf_setzen', { parameter: { aktiv: false } }, TINO),
      /Administratoren vorbehalten/,
    )
    const { mailTriage } = await import('../../src/modules/ki/einkauf-agent.ts')
    const schluessel = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    process.env.KI_FAKE = '0'
    try {
      assert.match(await mailTriage(ids.nachricht0), /^Übersprungen — ANTHROPIC_API_KEY ist nicht gesetzt/)
    } finally {
      process.env.KI_FAKE = '1'
      if (schluessel) process.env.ANTHROPIC_API_KEY = schluessel
    }
  })

  test('Angebot per Mail: Vorschlag „Angebot erfassen" mit Staffel und KI-Entwurf — nichts gesendet', async () => {
    const m = fake.fakeMailEinliefern({
      threadId: 'g-pcb-1',
      von: 'Amy Li <amy@pcb.example>',
      betreff: `RE: RFQ ${ids.nummer}`,
      text: 'Hi Tino,\n\nPrice for 1000 pcs is 0.85 USD, MOQ 500.\n\nBest regards\nAmy',
      messageIdHeader: '<q1@pcb.example>',
      anhaenge: [
        { name: 'quotation.pdf', mime: 'application/pdf', bytes: Buffer.from('QUOTATION Shenzhen PCB\nPrice for 2000 pcs is 0.79 USD, MOQ 1000\n'.repeat(400)) },
        { name: 'preisliste.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.alloc(30_000, 1) },
      ],
    })
    await abgleichen()
    const n = await nachrichtVon(m.id)
    ids.nachricht = n.id
    ids.thread = n.thread_id
    const [t] = await h.sql<{ partner_id: string; einkaufsprojekt_id: string }[]>`
      select partner_id, einkaufsprojekt_id from mail_threads where id = ${ids.thread}`
    assert.deepEqual(t, { partner_id: ids.pcb, einkaufsprojekt_id: ids.projekt }, 'Regel: Domain → Lieferant, EP-Nummer → Projekt')

    await jobs() // Anhänge ablegen (allgemeine Spur) → reiht ki_dokument_lesen ein
    assert.ok((await kiJobs()) >= 3, 'Triage + zwei Dokumente')

    const triage = await jobZu('ki_mail_triage', 'nachricht_id', n.id)
    assert.equal(triage.status, 'done', triage.last_error ?? '')
    assert.match(triage.last_result ?? '', /KI-Agent hat gesichtet: 1 Vorschlag, 1 Entwurf/)

    const vorschlaege = await h.sql<
      { id: string; aktion: string; record_id: string; parameter: Record<string, unknown>; status: string; art: string; quelle: string; thread_id: string | null; einkaufsprojekt_id: string | null; partner_id: string | null; belege: { art: string; id: string }[] }[]
    >`select id, aktion, record_id, parameter, status::text, art, quelle, thread_id, einkaufsprojekt_id, partner_id, belege
      from ki_vorschlaege order by erstellt_am`
    const ausMail = vorschlaege.find((v) => v.quelle === 'mail_nachricht')!
    assert.ok(ausMail, 'Vorschlag aus der Mail')
    ids.vorschlagMail = ausMail.id
    assert.equal(ausMail.aktion, 'einkauf.angebot_erfassen')
    assert.equal(ausMail.art, 'angebot')
    assert.equal(ausMail.status, 'offen')
    assert.equal(ausMail.record_id, ids.projekt)
    assert.deepEqual(ausMail.parameter.staffeln, [{ position_id: ids.position, ab_menge: 1000, preis: 0.85 }])
    assert.equal(ausMail.parameter.moq, 500)
    assert.equal(ausMail.parameter.waehrung, 'USD')
    assert.equal(ausMail.parameter.partner_id, ids.pcb)
    assert.deepEqual(
      [ausMail.thread_id, ausMail.einkaufsprojekt_id, ausMail.partner_id],
      [ids.thread, ids.projekt, ids.pcb],
      'erscheint an Thread, Projekt und Lieferant',
    )
    assert.deepEqual(ausMail.belege.map((b) => [b.art, b.id]), [['nachricht', ids.nachricht]])

    // Der Entwurf: Antwort im Thread, Lieferantensprache + Deutsch, Status entwurf.
    const entwuerfe = await h.sql<{ id: string; status: string; quelle: string; an: string[]; betreff: string; sprache: string; text_de: string; text_ziel: string; erstellt_von: string; einkaufsprojekt_id: string }[]>`
      select id, status::text, quelle, an, betreff, sprache, text_de, text_ziel, erstellt_von, einkaufsprojekt_id
      from mail_entwuerfe where thread_id = ${ids.thread}`
    assert.equal(entwuerfe.length, 1)
    const e = entwuerfe[0]
    ids.entwurf = e.id
    assert.equal(e.status, 'entwurf')
    assert.equal(e.quelle, 'agent')
    assert.deepEqual(e.an, ['amy@pcb.example'])
    assert.equal(e.betreff, `Re: RFQ ${ids.nummer}`)
    assert.equal(e.sprache, 'en')
    assert.match(e.text_ziel, /^Dear Amy,\n\nthank you for your message and your quotation \(1000 pcs at 0\.85 USD\)/)
    assert.match(e.text_de, /^Guten Tag Amy,/)
    assert.equal(e.erstellt_von, 'KI-Agent (Einkauf)')
    assert.equal(e.einkaufsprojekt_id, ids.projekt)

    // Nichts gesendet: kein gmail_senden-Job, die Attrappe hat nichts verschickt.
    const [{ senden }] = await h.sql<{ senden: number }[]>`select count(*)::int as senden from integration_jobs where kind = 'gmail_senden'`
    assert.equal(senden, 0)
    assert.equal(fake.fakeGesendet().length, 0)

    // Sichtungsmarke, Verbrauch, Verlauf am Thread.
    assert.ok((await nachrichtVon(m.id)).ki_gesichtet_am)
    const [k] = await h.sql<{ ebene: string; modell: string; zweck: string; record_id: string }[]>`
      select ebene, modell, zweck, record_id from ki_verbrauch where zweck = 'mail_triage'`
    assert.deepEqual(k, { ebene: 'einkauf', modell: 'fake', zweck: 'mail_triage', record_id: ids.nachricht })
    const [log] = await h.sql<{ actor: string }[]>`
      select actor from audit_log where model = 'mail_thread' and record_id = ${ids.thread} and message like 'KI-Agent hat gesichtet%'`
    assert.equal(log.actor, 'KI-Agent (Einkauf)')
  })

  test('Dokument-Leser: PDF → Text (durchsuchbar) und Angebots-Vorschlag, Excel nicht lesbar', async () => {
    const dok = await h.sql<{ id: string; name: string; text_status: string | null; text_auszug: string | null }[]>`
      select id, name, text_status, text_auszug from dokumente order by name`
    const pdf = dok.find((d) => d.name === 'quotation.pdf')!
    const excel = dok.find((d) => d.name === 'preisliste.xlsx')!
    assert.equal(pdf.text_status, 'gelesen')
    assert.match(pdf.text_auszug ?? '', /Price for 2000 pcs is 0\.79 USD/)
    assert.equal(excel.text_status, 'nicht_lesbar')
    assert.equal(excel.text_auszug, null)
    const [treffer] = await h.sql<{ id: string }[]>`select id from dokumente where suche @@ plainto_tsquery('simple', 'quotation shenzhen')`
    assert.equal(treffer.id, pdf.id, 'Volltext über den gelesenen Text')
    const excelJob = await jobZu('ki_dokument_lesen', 'dokument_id', excel.id)
    assert.match(excelJob.last_result ?? '', /Excel ist nicht lesbar/)

    const [v] = await h.sql<{ id: string; aktion: string; parameter: Record<string, unknown>; belege: { art: string; id: string }[] }[]>`
      select id, aktion, parameter, belege from ki_vorschlaege where quelle = 'dokument' and quelle_id = ${pdf.id}`
    assert.equal(v.aktion, 'einkauf.angebot_erfassen')
    assert.equal(v.parameter.quell_dokument_id, pdf.id)
    assert.deepEqual(v.parameter.staffeln, [{ position_id: ids.position, ab_menge: 2000, preis: 0.79 }])
    assert.deepEqual(v.belege.map((b) => b.art), ['dokument'])
    ids.vorschlagDokument = v.id
  })

  test('Idempotent: dieselbe Nachricht wird nicht zweimal gesichtet; das Cockpit zeigt die offenen Vorschläge', async () => {
    const { mailTriage } = await import('../../src/modules/ki/einkauf-agent.ts')
    assert.equal(await mailTriage(ids.nachricht), 'Schon gesichtet')
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from mail_entwuerfe where quelle = 'agent'`
    assert.equal(n, 1)

    const { cockpitLaden } = await import('../../src/modules/einkauf/cockpit.ts')
    const eintraege = (await cockpitLaden(h.sql, { finanzen: false })).filter((e) => e.kategorie === 'ki_vorschlaege')
    assert.equal(eintraege.length, 2)
    assert.ok(eintraege.every((e) => e.link === `/einkauf/posteingang/${ids.thread}#ki-vorschlaege`))
  })

  test('Annehmen: die Aktion läuft als der annehmende Mensch (Audit-Akteur), das Angebot trägt quelle agent', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: ids.vorschlagMail }, FERTIGER),
      /Berechtigung/,
    )
    const r = await aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: ids.vorschlagMail }, TINO)
    assert.match(r.text ?? '', /^Angenommen — Angebot von Shenzhen PCB Ltd\. erfasst/)
    const [v] = await h.sql<{ status: string; entschieden_von: string; ergebnis: string; ergebnis_link: string }[]>`
      select status::text, entschieden_von, ergebnis, ergebnis_link from ki_vorschlaege where id = ${ids.vorschlagMail}`
    assert.equal(v.status, 'angenommen')
    assert.equal(v.entschieden_von, 'tino')
    assert.match(v.ergebnis, /Angebot von Shenzhen PCB Ltd\. erfasst/)
    assert.equal(v.ergebnis_link, `/einkauf/projekte/${ids.projekt}`)

    const [a] = await h.sql<{ id: string; quelle: string; erfasst_von: string; moq: number; waehrung: string; quell_nachricht_id: string }[]>`
      select id, quelle, erfasst_von, moq::float as moq, waehrung, quell_nachricht_id from lieferantenangebote where projekt_id = ${ids.projekt}`
    assert.deepEqual(
      { quelle: a.quelle, erfasst_von: a.erfasst_von, moq: a.moq, waehrung: a.waehrung, quell_nachricht_id: a.quell_nachricht_id },
      { quelle: 'agent', erfasst_von: 'tino', moq: 500, waehrung: 'USD', quell_nachricht_id: ids.nachricht },
    )
    const [s] = await h.sql<{ ab_menge: number; preis: number }[]>`
      select ab_menge::float as ab_menge, preis::float as preis from lieferantenangebot_staffeln where angebot_id = ${a.id}`
    assert.deepEqual(s, { ab_menge: 1000, preis: 0.85 })

    // Audit: die innere Aktion trägt den Menschen als Akteur, nicht den Agenten.
    const audit = await h.sql<{ message: string; actor: string }[]>`
      select message, actor from audit_log where model = 'aktion' and message like 'einkauf.%' order by id`
    const innen = audit.find((x) => x.message.startsWith('einkauf.angebot_erfassen'))!
    assert.equal(innen.actor, 'tino')
    assert.ok(audit.some((x) => x.message.startsWith('einkauf.vorschlag_annehmen') && x.actor === 'tino'))

    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: ids.vorschlagMail }, TINO),
      /schon entschieden/,
    )
    const [{ angebote }] = await h.sql<{ angebote: number }[]>`select count(*)::int as angebote from lieferantenangebote`
    assert.equal(angebote, 1, 'Doppelklick führt nicht zweimal aus')
  })

  test('Verwerfen führt nichts aus', async () => {
    await aktionAusfuehrenGeprueft('einkauf.vorschlag_verwerfen', { recordId: ids.vorschlagDokument, parameter: { grund: 'Gleiches Angebot als PDF' } }, TINO)
    const [v] = await h.sql<{ status: string; entschieden_von: string; ergebnis: string }[]>`
      select status::text, entschieden_von, ergebnis from ki_vorschlaege where id = ${ids.vorschlagDokument}`
    assert.deepEqual(v, { status: 'verworfen', entschieden_von: 'tino', ergebnis: 'Gleiches Angebot als PDF' })
    const [{ angebote }] = await h.sql<{ angebote: number }[]>`select count(*)::int as angebote from lieferantenangebote`
    assert.equal(angebote, 1)
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: ids.vorschlagDokument }, TINO),
      /schon entschieden/,
    )
  })

  test('Gescheitert → Fehler am Vorschlag; Ändern prüft gegen die Aktion, danach Annehmen', async () => {
    // Ein Vorschlag mit einer Staffel auf eine fremde Position (wie ein Modell sie verwechseln könnte).
    const [fremd] = await h.sql<{ id: string }[]>`select gen_random_uuid() as id`
    const [v] = await h.sql<{ id: string }[]>`
      insert into ki_vorschlaege (aktion, parameter, record_id, art, titel, begruendung, belege, modell, quelle, quelle_id,
                                  thread_id, partner_id, einkaufsprojekt_id)
      values ('einkauf.angebot_erfassen',
              ${h.sql.json({ partner_id: ids.pcb, waehrung: 'USD', werkzeugkosten: 0, musterkosten: 0, staffeln: [{ position_id: fremd.id, ab_menge: 5000, preis: 0.7 }] })},
              ${ids.projekt}, 'angebot', 'Angebot in USD', 'Test: Staffel auf falscher Position.',
              ${h.sql.json([{ art: 'nachricht', id: ids.nachricht }])}, 'fake', 'mail_nachricht', ${ids.nachricht},
              ${ids.thread}, ${ids.pcb}, ${ids.projekt})
      returning id`
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: v.id }, TINO),
      /ließ sich nicht ausführen/,
    )
    const [f] = await h.sql<{ status: string; fehler: string }[]>`select status::text, fehler from ki_vorschlaege where id = ${v.id}`
    assert.equal(f.status, 'fehler')
    assert.ok(f.fehler.length > 0)

    // Ändern: Formular wie auf der Karte (p:/t:/j:), ungültige Werte werden abgewiesen.
    const kaputt = new FormData()
    kaputt.set('p:partner_id', ids.pcb)
    kaputt.set('t:partner_id', 'string')
    kaputt.set('p:waehrung', 'US')
    kaputt.set('t:waehrung', 'string')
    kaputt.set('j:staffeln', JSON.stringify([{ position_id: ids.position, ab_menge: 5000, preis: 0.7 }]))
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.vorschlag_aendern', { recordId: v.id, formData: kaputt }, TINO), /waehrung/)

    const fd = new FormData()
    fd.set('p:partner_id', ids.pcb)
    fd.set('t:partner_id', 'string')
    fd.set('p:waehrung', 'USD')
    fd.set('t:waehrung', 'string')
    fd.set('j:staffeln', JSON.stringify([{ position_id: ids.position, ab_menge: 5000, preis: 0.7 }]))
    await aktionAusfuehrenGeprueft('einkauf.vorschlag_aendern', { recordId: v.id, formData: fd }, TINO)
    const [g] = await h.sql<{ status: string; geaendert_von: string; parameter: { staffeln: unknown } }[]>`
      select status::text, geaendert_von, parameter from ki_vorschlaege where id = ${v.id}`
    assert.equal(g.status, 'offen')
    assert.equal(g.geaendert_von, 'tino')
    assert.deepEqual(g.parameter.staffeln, [{ position_id: ids.position, ab_menge: 5000, preis: 0.7 }])

    const r = await aktionAusfuehrenGeprueft('einkauf.vorschlag_annehmen', { recordId: v.id }, TINO)
    assert.match(r.text ?? '', /Version 2/)
  })

  test('Der Entwurf bleibt ein Entwurf, bis ein Mensch freigibt', async () => {
    const [e] = await h.sql<{ status: string }[]>`select status::text from mail_entwuerfe where id = ${ids.entwurf}`
    assert.equal(e.status, 'entwurf')
    const [{ senden }] = await h.sql<{ senden: number }[]>`select count(*)::int as senden from integration_jobs where kind = 'gmail_senden'`
    assert.equal(senden, 0, 'auch nach Annehmen/Verwerfen der Vorschläge wird nichts gesendet')
  })

  test('Alibaba-Chat von Hand erfasst reiht die Sichtung ebenfalls ein; ignorierte Threads werden übersprungen', async () => {
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.nachricht_erfassen',
      { parameter: { kanal: 'alibaba', richtung: 'eingang', partner_id: ids.pcb, text: 'MOQ 300, price 0.95 USD for 300 pcs' } },
      TINO,
    )
    const [n] = await h.sql<{ id: string }[]>`select id from mail_nachrichten where thread_id = ${r.recordId!}`
    const job = await jobZu('ki_mail_triage', 'nachricht_id', n.id)
    assert.equal(job.status, 'pending')
    await aktionAusfuehrenGeprueft('einkauf.mail_status_setzen', { recordId: r.recordId!, parameter: { status: 'ignoriert' } }, TINO)
    await kiJobs()
    assert.match((await jobZu('ki_mail_triage', 'nachricht_id', n.id)).last_result ?? '', /ignoriert/)
  })

  test('Monatsgrenze erreicht → übersprungen; Ebene aus → übersprungen', async () => {
    await aktionAusfuehrenGeprueft('einstellungen.ki_einkauf_setzen', { parameter: { aktiv: true, monats_tokens: 1 } }, ADMIN)
    await h.sql`insert into ki_verbrauch (ebene, modell, zweck, input_tokens, output_tokens) values ('einkauf', 'test', 'test', 5, 5)`
    const { mailTriage } = await import('../../src/modules/ki/einkauf-agent.ts')
    assert.match(await mailTriage(ids.nachricht0), /Monatsgrenze von 1 Token erreicht/)
    await aktionAusfuehrenGeprueft('einstellungen.ki_einkauf_setzen', { parameter: { aktiv: false } }, ADMIN)
    assert.match(await mailTriage(ids.nachricht0), /ist aus/)
  })
})
