/**
 * Wächter der Einstellungen (Entscheidungslog 2026-09-26): die Landkarte
 * (src/modules/einstellungen/bereiche.ts) ist die einzige Liste der Bereiche.
 * Jede Seite steht darin, jeder Eintrag hat eine Seite und einen Befehl, jede
 * Seite trägt den gemeinsamen Kopf — und settings wird in der Oberfläche
 * nirgends mehr direkt geschrieben, sondern nur über die Registry.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  EINSTELLUNGS_BEREICHE,
  GRUPPEN,
  aktiverBereich,
  bereichZu,
} from '../src/modules/einstellungen/bereiche.ts'

const APP = join(import.meta.dirname, '..', 'src', 'app')
const ERP = join(APP, '(erp)')
const EINSTELLUNGEN = join(ERP, 'einstellungen')

function dateienUnter(ordner: string): string[] {
  return readdirSync(ordner).flatMap((name) => {
    const pfad = join(ordner, name)
    return statSync(pfad).isDirectory() ? dateienUnter(pfad) : [pfad]
  })
}

describe('Einstellungen (Wächter)', () => {
  test('jeder Bereich hat eine Seite, jede Seite steht in der Landkarte', () => {
    for (const b of EINSTELLUNGS_BEREICHE) {
      assert.ok(existsSync(join(ERP, b.href, 'page.tsx')), `Seite fehlt: ${b.href}`)
    }
    const seiten = dateienUnter(EINSTELLUNGEN)
      .filter((d) => d.endsWith('/page.tsx'))
      .map((d) => '/' + relative(ERP, d).replace(/\/page\.tsx$/, ''))
    const bekannt = new Set(EINSTELLUNGS_BEREICHE.map((b) => b.href))
    const verwaist = seiten.filter((s) => !bekannt.has(s))
    assert.deepEqual(verwaist, [],
      `Seiten unter /einstellungen ohne Eintrag in modules/einstellungen/bereiche.ts:\n${verwaist.join('\n')}`)
  })

  test('jeder Bereich ist im Befehlsfeld auffindbar', () => {
    const befehle = readFileSync(join(import.meta.dirname, '..', 'src', 'modules', 'befehle.ts'), 'utf8')
    const fehlend = EINSTELLUNGS_BEREICHE.filter((b) => !befehle.includes(`href: '${b.href}'`)).map((b) => b.href)
    assert.deepEqual(fehlend, [], `Fehlen in src/modules/befehle.ts:\n${fehlend.join('\n')}`)
  })

  test('Gruppen zusammenhängend in fester Reihenfolge, Gefahrenzone zuletzt', () => {
    const folge = EINSTELLUNGS_BEREICHE.map((b) => b.gruppe).filter((g, i, a) => i === 0 || a[i - 1] !== g)
    assert.deepEqual(folge, [...GRUPPEN], 'jede Gruppe genau ein Block, in der Reihenfolge von GRUPPEN')
    const letzte = EINSTELLUNGS_BEREICHE.at(-1)!
    assert.equal(letzte.href, '/einstellungen/gefahrenzone')
    assert.equal(letzte.gefahr, true)
    assert.equal(EINSTELLUNGS_BEREICHE.filter((b) => b.gefahr).length, 1, 'nur eine Gefahrenzone')
    assert.equal(new Set(EINSTELLUNGS_BEREICHE.map((b) => b.label)).size, EINSTELLUNGS_BEREICHE.length, 'Namen eindeutig')
  })

  test('jede Seite trägt den gemeinsamen Kopf mit ihrem eigenen Pfad', () => {
    for (const b of EINSTELLUNGS_BEREICHE) {
      const quelle = readFileSync(join(ERP, b.href, 'page.tsx'), 'utf8')
      assert.ok(!/<PageHeader\b/.test(quelle), `${b.href}: eigener PageHeader statt EinstellungenKopf`)
      assert.ok(
        quelle.includes(`href="${b.href}"`) && quelle.includes('<EinstellungenKopf'),
        `${b.href}: <EinstellungenKopf href="${b.href}"> fehlt`,
      )
      assert.match(quelle, /requireArea\('einstellungen'\)/, `${b.href}: eigener Guard fehlt (Layouts laufen nicht bei jeder Navigation)`)
    }
  })

  test('aktiver Bereich: längster passender Pfad, die Wurzel nur exakt', () => {
    assert.equal(aktiverBereich('/einstellungen'), '/einstellungen')
    assert.equal(aktiverBereich('/einstellungen/benutzer'), '/einstellungen/benutzer')
    assert.equal(aktiverBereich('/einstellungen/versandregeln'), '/einstellungen/versandregeln')
    assert.equal(aktiverBereich('/einstellungen/versand'), '/einstellungen/versand')
    assert.equal(aktiverBereich('/einstellungen/unbekannt'), undefined)
    assert.equal(bereichZu('/einstellungen/ki').label, 'KI-Modelle')
    assert.throws(() => bereichZu('/einstellungen/gibtsnicht'), /fehlt in src\/modules\/einstellungen\/bereiche\.ts/)
  })

  test('settings wird in der Oberfläche nicht direkt geschrieben — nur über die Registry', () => {
    // Geschlossene Liste: der Heartbeat der Druck-Agenten schreibt seinen
    // Zeitstempel selbst (kein Benutzer, kein Torwächter — Token-Aufruf).
    const ERLAUBT = new Set(['api/druck/abholen/route.ts'])
    const treffer = dateienUnter(APP)
      .filter((d) => /\.(ts|tsx)$/.test(d))
      .filter((d) => /\b(insert\s+into|update)\s+settings\b/i.test(readFileSync(d, 'utf8')))
      .map((d) => relative(APP, d))
      .filter((d) => !ERLAUBT.has(d))
    assert.deepEqual(treffer, [],
      `Direkte settings-Schreiber in src/app (Registry-Aktion anlegen):\n${treffer.join('\n')}`)
  })
})

describe('Einstellungen: Registry statt Umgehung (Schemas)', () => {
  const fd = (werte: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(werte)) f.set(k, v)
    return f
  }

  test('Freigaben: leer = null (Pflicht aus), Komma erlaubt, negativ abgewiesen', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const a = REGISTRY['einstellungen.freigaben_setzen']
    assert.equal(a.nurAdmin, true)
    assert.deepEqual(a.schema.parse(a.formdata!(fd({ einkauf_limit: '' }))), { einkauf_limit: null })
    assert.deepEqual(a.schema.parse(a.formdata!(fd({ einkauf_limit: '5000,50' }))), { einkauf_limit: 5000.5 })
    assert.equal(a.schema.safeParse(a.formdata!(fd({ einkauf_limit: '-1' }))).success, false)
    assert.equal(a.schema.safeParse(a.formdata!(fd({ einkauf_limit: 'viel' }))).success, false)
  })

  test('Finanz-Stellschrauben: alle Felder Pflicht, Wertebereiche aus FINANZ_FELDER', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const { FINANZ_FELDER } = await import('../src/modules/einstellungen/finanz-parameter.ts')
    const a = REGISTRY['einstellungen.finanz_parameter_setzen']
    const gueltig = Object.fromEntries(FINANZ_FELDER.map((f) => [f.name, String(f.min ?? 0)]))
    const geparst = a.schema.parse(a.formdata!(fd(gueltig))) as Record<string, number>
    assert.equal(Object.keys(geparst).length, FINANZ_FELDER.length)
    assert.equal(a.schema.safeParse(a.formdata!(fd({ ...gueltig, ust_zahltag: '29' }))).success, false, 'max greift')
    assert.equal(a.schema.safeParse(a.formdata!(fd({ ...gueltig, versand_pct: '' }))).success, false, 'leer abgewiesen')
    assert.deepEqual(a.revalidate, ['/einstellungen/finanzen', '/finanzen'])
  })

  test('Belegverhalten und Labelformat', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const b = REGISTRY['einstellungen.belegverhalten_setzen']
    assert.deepEqual(b.schema.parse(b.formdata!(fd({ sales_lock: 'on' }))), { sales_lock: true, purchase_lock: false })
    const v = REGISTRY['einstellungen.versand_vorgaben_setzen']
    assert.deepEqual(v.schema.parse(v.formdata!(fd({ print_format: 'A4' }))), { print_format: 'A4' })
    assert.equal(v.schema.safeParse({ print_format: 'A5' }).success, false)
  })
})

describe('Einstellungen: Stammdaten über die Registry', () => {
  const fd = (werte: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(werte)) f.set(k, v)
    return f
  }

  test('Steuer, Zahlungsbedingung, Kategorie: Pflichtfelder und Skonto-Regel', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const steuer = REGISTRY['einstellungen.steuer_anlegen']
    assert.equal(steuer.nurAdmin, true)
    const geparst = steuer.schema.parse(steuer.formdata!(fd({ name: 'USt 7 %', amount: '7', type_tax_use: 'sale' })))
    assert.equal(geparst.name, 'USt 7 %')
    assert.equal(geparst.amount, 7)
    assert.equal(geparst.type_tax_use, 'sale')
    assert.equal(geparst.price_include, false)
    assert.equal(geparst.description, undefined)
    assert.equal(steuer.schema.safeParse(steuer.formdata!(fd({ name: 'x', amount: '120', type_tax_use: 'sale' }))).success, false)
    assert.equal(steuer.schema.safeParse(steuer.formdata!(fd({ name: ' ', amount: '7', type_tax_use: 'sale' }))).success, false)

    const zb = REGISTRY['einstellungen.zahlungsbedingung_anlegen']
    assert.equal(zb.schema.safeParse(zb.formdata!(fd({ name: '30 Tage', nb_days: '30', delay_type: 'days_after' }))).success, true)
    const ohneWerte = zb.schema.safeParse(
      zb.formdata!(fd({ name: 'Skonto', nb_days: '30', delay_type: 'days_after', early_discount: 'on', discount_percentage: '', discount_days: '' })),
    )
    assert.equal(ohneWerte.success, false, 'Skonto ohne Prozent/Tage abgewiesen')
    assert.match(JSON.stringify(ohneWerte.error?.issues), /Mit Skonto bitte Prozent und Tage angeben/, 'deutsche Regel statt Typfehler')
    assert.equal(
      zb.schema.safeParse(zb.formdata!(fd({
        name: 'Skonto', nb_days: '30', delay_type: 'days_after', early_discount: 'on', discount_percentage: '2', discount_days: '10',
      }))).success,
      true,
    )

    const kat = REGISTRY['einstellungen.kategorie_anlegen']
    const k = kat.schema.parse(kat.formdata!(fd({ name: 'Keycaps', parent_id: '' })))
    assert.equal(k.name, 'Keycaps')
    assert.equal(k.parent_id, undefined, 'leere Auswahl = oberste Ebene')
    assert.equal(REGISTRY['einstellungen.tag_loeschen'].bindung, 'beleg')
  })
})

describe('Einstellungen: Schnittstellen', () => {
  test('Umgebungsstand: nur Namen, Pflicht fehlt → unvollständig, Attrappe zählt als vollständig', async () => {
    const { ANBINDUNGEN, anbindungZu, anbindungsStand } = await import('../src/modules/einstellungen/umgebung.ts')
    const dhl = anbindungZu('dhl')
    const leer = anbindungsStand(dhl, {})
    assert.equal(leer.vollstaendig, false)
    assert.deepEqual(leer.fehlend, ['DHL_API_KEY', 'DHL_API_SECRET', 'DHL_GKP_USER', 'DHL_GKP_PASSWORD', 'DHL_BILLING_NUMBER'])
    assert.equal(anbindungsStand(dhl, { DHL_FAKE: '1' }).vollstaendig, true)
    const voll = anbindungsStand(dhl, {
      DHL_API_KEY: 'k', DHL_API_SECRET: 's', DHL_GKP_USER: 'u', DHL_GKP_PASSWORD: 'p', DHL_BILLING_NUMBER: '1',
    })
    assert.equal(voll.vollstaendig, true)
    assert.ok(!JSON.stringify(voll).includes('"k"'), 'Werte tauchen nirgends auf')
    assert.equal(anbindungsStand(dhl, { DHL_API_KEY: '   ' }).variablen.find((v) => v.name === 'DHL_API_KEY')!.gesetzt, false, 'Leerzeichen gilt nicht')

    const shopify = anbindungZu('shopify')
    assert.deepEqual(anbindungsStand(shopify, { SHOPIFY_SHOP_DOMAIN: 'x', SHOPIFY_ADMIN_TOKEN: 't' }).fehlend, [],
      'statisches Admin-Token ersetzt Client ID/Secret')
    // Jede Anbindung des Wächters hat eine Karte (bis auf die Druckbrücke, die unter Versand & Druck steht).
    const schluessel = new Set(ANBINDUNGEN.map((a) => a.schluessel))
    for (const d of ['dhl', 'shopify', 'mail', 'ki', 'sprache', 'telegram']) assert.ok(schluessel.has(d as never), d)
  })

  test('Webhook-Registrierung: nur https, über die Registry', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const a = REGISTRY['integrationen.webhooks_registrieren']
    assert.equal(a.nurAdmin, true)
    assert.equal(a.schema.safeParse({ url: 'https://erp.example.com' }).success, true)
    assert.equal(a.schema.safeParse({ url: 'http://localhost:3000' }).success, false)
    assert.equal(a.schema.safeParse({ url: 'kein link' }).success, false)
  })
})
