/**
 * notiz.anlegen — EIN Schreibweg für UI-Kommentare und KI-Notizen
 * (Entscheidungslog 2026-08-27). Geprüft wird die alte Kommentar-Semantik:
 * kommentieren darf, wer den Bereich des Datensatzes SEHEN kann; fremde
 * Bereiche und tote Datensätze werden abgewiesen.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_notiz_check'
const ADMIN = { name: 'notiz-test', role: 'admin' as const }

let h: Harness
let templateId: string

before(async () => {
  h = await harnessStart(DATENBANK)
  await aktionAusfuehrenGeprueft(
    'produkte.produkt_anlegen',
    { parameter: { name: 'Notiz-Testprodukt', sku: 'NTZ-1' } },
    ADMIN,
  )
  const [zeile] = await h.sql<{ id: string }[]>`
    select id from product_templates where name = 'Notiz-Testprodukt'`
  templateId = zeile.id
})
after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('notiz.anlegen: der eine Schreibweg für Kommentare', () => {
  test('die Notiz landet als note im audit_log', async () => {
    const ergebnis = await aktionAusfuehrenGeprueft(
      'notiz.anlegen',
      { recordId: templateId, parameter: { model: 'product_template', text: 'Bitte Gewicht pflegen' } },
      ADMIN,
    )
    assert.match(ergebnis.text ?? '', /Notiz hinterlegt/)

    const [eintrag] = await h.sql<{ message: string; actor: string }[]>`
      select message, actor from audit_log
      where model = 'product_template' and record_id = ${templateId} and kind = 'note'`
    assert.ok(eintrag, 'der Verlauf speist sich aus dem audit_log')
    assert.equal(eintrag.message, 'Bitte Gewicht pflegen')
    assert.equal(eintrag.actor, 'notiz-test')
  })

  test('Lese-Rollen dürfen kommentieren, wo sie lesen dürfen — sonst nicht', async () => {
    // Die Fertigung sieht Produkte (lesend) → Kommentar erlaubt.
    await aktionAusfuehrenGeprueft(
      'notiz.anlegen',
      { recordId: templateId, parameter: { model: 'product_template', text: 'Aus der Fertigung' } },
      { name: 'werker', role: 'fertigung' },
    )

    // Kontakte sieht die Fertigung nicht — der Modell-Bereich entscheidet,
    // nicht der Aktions-Bereich 'fehler' (den jede Rolle schreiben darf).
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'notiz.anlegen',
        { recordId: templateId, parameter: { model: 'partner', text: 'verboten' } },
        { name: 'werker', role: 'fertigung' },
      ),
      /fehlt Ihrer Rolle die Berechtigung/,
    )
  })

  test('tote Datensätze werden abgewiesen', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'notiz.anlegen',
        {
          recordId: '00000000-0000-4000-8000-000000000000',
          parameter: { model: 'sales_order', text: 'ins Leere' },
        },
        ADMIN,
      ),
      /existiert nicht/,
    )
  })
})
