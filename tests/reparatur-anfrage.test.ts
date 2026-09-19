import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY } from '../src/modules/prozesse/registry/index.ts'
import { aktionErlaubt } from '../src/modules/prozesse/torwaechter.ts'
import { JOB_KATALOG } from '../src/modules/prozesse/jobs-katalog.ts'
import {
  ANFRAGE_FELDER,
  kontaktAusAnfrage,
  normalisiereAnfrage,
  pruefeAnfrage,
} from '../src/modules/shared/reparaturanfrage.ts'
import { closeDb, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Reparaturanfrage aus dem Kundenformular — der zweite Schreibweg ohne
 * Sitzung (Entscheidungslog 2026-09-19). Geprüft wird beides: dass die
 * Eingangsregeln greifen (sie sind die ganze Verteidigung) und dass alles
 * DANACH wieder über Registry-Aktionen im Prozess läuft.
 */

const VOLLSTAENDIG = {
  kontakt_name: 'Erika Musterfrau',
  email: 'erika@example.com',
  telefon: '+49 30 1234567',
  strasse: 'Prozessweg',
  hausnummer: '7',
  plz: '10115',
  ort: 'Berlin',
  land: 'de',
  fehlerbeschreibung: 'Die Leertaste prellt — jeder zweite Anschlag kommt doppelt.',
  bestellnummer: '#1042',
}

describe('Reparaturanfrage: Eingangsregeln', () => {
  test('eine vollständige Anfrage passiert, das Land wird normalisiert', () => {
    const daten = normalisiereAnfrage(VOLLSTAENDIG)
    assert.deepEqual(pruefeAnfrage(daten), {})
    assert.equal(daten.land, 'DE')
  })

  test('jedes Pflichtfeld wird einzeln gemeldet, Telefon und Bestellnummer nicht', () => {
    for (const feld of ['kontakt_name', 'email', 'strasse', 'hausnummer', 'plz', 'ort', 'fehlerbeschreibung'] as const) {
      const fehler = pruefeAnfrage(normalisiereAnfrage({ ...VOLLSTAENDIG, [feld]: '   ' }))
      assert.ok(fehler[feld], `${feld} muss gemeldet werden`)
    }
    const ohneOptional = normalisiereAnfrage({ ...VOLLSTAENDIG, telefon: '', bestellnummer: '' })
    assert.deepEqual(pruefeAnfrage(ohneOptional), {})
  })

  test('E-Mail-Muster, Ländercode und eine zu knappe Fehlerbeschreibung fallen durch', () => {
    assert.ok(pruefeAnfrage(normalisiereAnfrage({ ...VOLLSTAENDIG, email: 'keine-adresse' })).email)
    assert.ok(pruefeAnfrage(normalisiereAnfrage({ ...VOLLSTAENDIG, land: 'xyz' })).land)
    assert.ok(pruefeAnfrage(normalisiereAnfrage({ ...VOLLSTAENDIG, fehlerbeschreibung: 'kaputt' })).fehlerbeschreibung)
    assert.equal(normalisiereAnfrage({ ...VOLLSTAENDIG, land: '' }).land, 'DE', 'leer heißt Deutschland')
  })

  test('Überlängen werden beschnitten, nicht abgewiesen; Zeilenumbrüche bleiben in der Beschreibung', () => {
    const lang = normalisiereAnfrage({
      ...VOLLSTAENDIG,
      kontakt_name: 'x'.repeat(500),
      fehlerbeschreibung: 'Zeile eins\nZeile zwei   mit   Lücken',
      ort: 'Berlin   Mitte',
    })
    assert.equal(lang.kontakt_name.length, 120)
    assert.deepEqual(pruefeAnfrage(lang), {})
    assert.match(lang.fehlerbeschreibung, /\n/)
    assert.equal(lang.ort, 'Berlin Mitte')
  })

  test('kontaktAusAnfrage liest den Vorgang und wirft in Klartext, wenn das Nötigste fehlt', () => {
    const k = kontaktAusAnfrage(VOLLSTAENDIG)
    assert.equal(k.name, 'Erika Musterfrau')
    assert.equal(k.land, 'DE')
    assert.equal(k.bestellnummer, '#1042')
    assert.throws(() => kontaktAusAnfrage({ ...VOLLSTAENDIG, email: '' }), /unvollständig \(email\)/)
    assert.equal(kontaktAusAnfrage({ ...VOLLSTAENDIG, bestellnummer: '' }).bestellnummer, undefined)
  })
})

describe('Reparaturanfrage: Felder und Prozess', () => {
  test('die Felder des Prozesses sind genau die des Formulars — nur im Anlage-Schritt', async () => {
    await withRollback(async (t) => {
      const felder = await t<{ name: string; schritte: string[] | null; pflicht: boolean }[]>`
        select name, schritte, pflicht from feld_definitionen
        where modell = 'vorgang' and prozess_code = 'reparatur_anfrage'`
      assert.deepEqual(felder.map((f) => f.name).sort(), [...ANFRAGE_FELDER].sort())
      for (const f of felder) {
        assert.deepEqual(f.schritte, ['anlegen'], `${f.name}: nur beim Erfassen sichtbar`)
      }
      const pflicht = felder.filter((f) => f.pflicht).map((f) => f.name).sort()
      assert.deepEqual(pflicht, ['email', 'fehlerbeschreibung', 'hausnummer', 'kontakt_name', 'land', 'ort', 'plz', 'strasse'])
    })
  })

  test('der Prozess ist aktiv, hängt die Reparatur als Teilprozess an und gehört zu den Paketen', async () => {
    await withRollback(async (t) => {
      const [p] = await t<{ aktiv: boolean; modell: string; bereich: string }[]>`
        select aktiv, modell, bereich from prozesse where code = 'reparatur_anfrage'`
      assert.ok(p, 'Prozess reparatur_anfrage fehlt')
      assert.equal(p.modell, 'vorgang')
      assert.equal(p.bereich, 'reparatur')
      const schritte = await t<{ code: string; art: string; teilprozess: string | null }[]>`
        select code, art::text, teilprozess from prozess_schritte
        where version_id = prozess_aktive_version('reparatur_anfrage') order by sequence`
      assert.deepEqual(
        schritte.map((s) => s.code),
        ['start', 'anlegen', 'rueckfrage', 'annehmen', 'ablehnen', 'reparatur', 'ende'],
      )
      assert.equal(schritte.find((s) => s.code === 'reparatur')?.teilprozess, 'reparatur')
      const pakete = await t<{ code: string }[]>`
        select code from prozess_pakete where 'reparatur_anfrage' = any(prozess_codes) order by code`
      assert.deepEqual(pakete.map((p) => p.code), ['d2c_hersteller', 'werkstatt'])
    })
  })

  test('die Drosselabfrage zählt nur Eingänge des Kundenformulars im Fenster', async () => {
    await withRollback(async (t) => {
      const hash = 'a'.repeat(32)
      for (let i = 0; i < 3; i++) {
        await t`insert into vorgaenge (number, prozess_code, state, quelle, absender_hash)
                values (next_sequence('vorgang'), 'reparatur_anfrage', 'neu', 'kundenformular', ${hash})`
      }
      await t`insert into vorgaenge (number, prozess_code, state, quelle, absender_hash, created_at)
              values (next_sequence('vorgang'), 'reparatur_anfrage', 'neu', 'kundenformular', ${hash},
                      now() - interval '11 minutes')`
      await t`insert into vorgaenge (number, prozess_code, state)
              values (next_sequence('vorgang'), 'reparatur_anfrage', 'neu')`
      const [z] = await t<{ n: number }[]>`
        select count(*)::int as n from vorgaenge
        where quelle = 'kundenformular' and absender_hash = ${hash}
          and created_at > now() - interval '10 minutes'`
      assert.equal(z.n, 3)
    })
  })
})

describe('Reparaturanfrage: die Bearbeitung läuft über die Registry', () => {
  test('reparatur.anfrage_annehmen arbeitet am Vorgang, nur für den Bereich Reparatur', () => {
    const a = REGISTRY['reparatur.anfrage_annehmen']
    assert.ok(a, 'Aktion fehlt in der Registry')
    assert.equal(a.bindung, 'beleg')
    assert.equal(a.modell, 'vorgang')
    assert.equal(a.bereich, 'reparatur')
    assert.deepEqual(a.uebergang, { von: ['neu', 'rueckfrage'], nach: ['angenommen'] })
    // Bereich reparatur: Büro, Lager und Fertigung dürfen annehmen (permissions.ts).
    for (const rolle of ['admin', 'mitarbeiter', 'lager', 'fertigung'] as const) {
      assert.equal(aktionErlaubt(a, rolle, []), true, rolle)
    }
    assert.equal(a.schema.safeParse({ state: 'angenommen', variant_id: 'v' }).success, true)
    assert.equal(a.schema.safeParse({ state: 'angenommen' }).success, false, 'Produkt ist Pflicht')
    const p = a.schema.parse({ state: 'angenommen', variant_id: 'v' })
    assert.equal(p.label_senden, true, 'Retourenlabel ist der Normalfall')
  })

  test('die drei neuen Belegaktionen erklären ihre Zustandsübergänge', () => {
    assert.deepEqual(REGISTRY['reparatur.retourenlabel_senden'].uebergang, {
      von: ['new', 'awaiting_device'], nach: ['awaiting_device'],
    })
    assert.deepEqual(REGISTRY['reparatur.geraet_eingegangen'].uebergang, {
      von: ['new', 'awaiting_device'], nach: ['received'],
    })
    assert.deepEqual(REGISTRY['reparatur.rueckversand_label'].uebergang, {
      von: ['repaired'], nach: ['shipped'],
    })
    assert.ok(REGISTRY['reparatur.bestaetigen'].uebergang?.von.includes('received'))
    assert.ok(REGISTRY['reparatur.stornieren'].uebergang?.von.includes('awaiting_device'))
  })

  test('die Eingangsbestätigung ist ein Outbox-Job mit anbieterneutraler Fähigkeit', () => {
    assert.equal(JOB_KATALOG.send_repair_request_email.faehigkeit, 'mail:anfrage_bestaetigung')
  })
})
