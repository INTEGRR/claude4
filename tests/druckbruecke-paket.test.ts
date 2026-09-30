/**
 * Druckbrücken-Paket (Download unter Einstellungen → Versand & Druck): das
 * ZIP ist lesbar, die Skripte tragen Adresse, Token, Name und Ziel, Freitext
 * kann nicht aus den Skripten ausbrechen. Unter Windows startet der
 * PowerShell-Agent ohne Node (CRLF, nur ASCII — Windows PowerShell 5.1 liest
 * Skripte ohne BOM als ANSI); der Node-Agent für Linux/macOS startet mit genau
 * den Flags, die das Shell-Skript benutzt.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { zipErstellen } from '../src/modules/shared/zip.ts'
import { druckbrueckePaket, oeffentlicheAdresse, skriptSicher, zielWert } from '../src/modules/versand/druckbruecke-paket.ts'

/** Liest ein ZIP über das zentrale Verzeichnis zurück — unabhängig vom Schreiber. */
function zipLesen(zip: Buffer): Map<string, Buffer> {
  const ende = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(ende >= 0, 'Ende des zentralen Verzeichnisses fehlt')
  const anzahl = zip.readUInt16LE(ende + 10)
  let pos = zip.readUInt32LE(ende + 16)
  const dateien = new Map<string, Buffer>()
  for (let i = 0; i < anzahl; i++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50)
    const gepacktLaenge = zip.readUInt32LE(pos + 20)
    const namensLaenge = zip.readUInt16LE(pos + 28)
    const lokal = zip.readUInt32LE(pos + 42)
    const name = zip.subarray(pos + 46, pos + 46 + namensLaenge).toString('utf8')
    assert.equal(zip.readUInt32LE(lokal), 0x04034b50)
    const daten = lokal + 30 + zip.readUInt16LE(lokal + 26) + zip.readUInt16LE(lokal + 28)
    dateien.set(name, inflateRawSync(zip.subarray(daten, daten + gepacktLaenge)))
    pos += 46 + namensLaenge + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32)
  }
  return dateien
}

const ANGABEN = {
  url: 'https://krnl.example.com/',
  token: 'a1b2c3d4e5f6',
  name: 'packtisch',
  ziel: 'labeldrucker' as const,
  drucker: 'Zebra GK420d',
  agentQuelle: '// Agent\nconsole.log("x")\n',
  agentPsQuelle: '# Agent\nWrite-Host "x"\n',
  erstellt: new Date('2026-09-29T10:00:00Z'),
}

describe('Druckbrücken-Paket', () => {
  test('ZIP: alle Dateien kommen byte-genau zurück, Namen in UTF-8', () => {
    const zip = zipErstellen([
      { name: 'a.txt', inhalt: 'hallo' },
      { name: 'Übersicht.txt', inhalt: Buffer.from('äöü ß'.repeat(200)) },
      { name: 'leer.txt', inhalt: '' },
    ])
    const dateien = zipLesen(zip)
    assert.deepEqual([...dateien.keys()], ['a.txt', 'Übersicht.txt', 'leer.txt'])
    assert.equal(dateien.get('a.txt')!.toString(), 'hallo')
    assert.equal(dateien.get('Übersicht.txt')!.toString(), 'äöü ß'.repeat(200))
    assert.equal(dateien.get('leer.txt')!.length, 0)
  })

  test('Startskript trägt Adresse, Token, Name, Ziel und Drucker — mit CRLF und ohne Umlaute', () => {
    const dateien = new Map(druckbrueckePaket(ANGABEN).map((d) => [d.name, String(d.inhalt)]))
    assert.deepEqual([...dateien.keys()], [
      'druckbruecke-starten.cmd', 'autostart-einrichten.cmd', 'druckbruecke-starten.sh',
      'LIESMICH.txt', 'druck-agent.ps1', 'druck-agent.ts', 'package.json',
    ])
    assert.equal(JSON.parse(dateien.get('package.json')!).type, 'module')
    const cmd = dateien.get('druckbruecke-starten.cmd')!
    for (const zeile of [
      'set "KRNL_URL=https://krnl.example.com"',
      'set "DRUCK_AGENT_TOKEN=a1b2c3d4e5f6"',
      'set "DRUCK_AGENT_NAME=packtisch"',
      'set "DRUCK_ZIELE=labeldrucker"',
      'set "DRUCKER=Zebra GK420d"',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0druck-agent.ps1"',
    ]) {
      assert.ok(cmd.includes(`${zeile}\r\n`), `fehlt: ${zeile}`)
    }
    assert.ok(!/[^\r]\n/.test(cmd), 'Windows-Skript nur mit CRLF')
    const nurAscii = (text: string) => [...text].every((zeichen) => zeichen.charCodeAt(0) < 128)
    assert.ok(nurAscii(cmd), 'die Konsole liest OEM — keine Umlaute im Skript')
    assert.ok(nurAscii(dateien.get('autostart-einrichten.cmd')!))
    assert.ok(!/^(node|where node)/m.test(cmd), 'Windows braucht kein Node.js')
    assert.equal(dateien.get('druck-agent.ps1'), '# Agent\r\nWrite-Host "x"\r\n', 'PowerShell-Agent mit CRLF')
    assert.equal(dateien.get('druck-agent.ts'), ANGABEN.agentQuelle, 'der Node-Agent kommt unverändert')
    assert.ok(dateien.get('LIESMICH.txt')!.startsWith('﻿'), 'UTF-8 mit BOM für den Windows-Editor')
  })

  test('„alles drucken" setzt keine Ziele; unbekannte Ziele fallen darauf zurück', () => {
    const cmd = String(druckbrueckePaket({ ...ANGABEN, ziel: 'alle' })[0].inhalt)
    assert.ok(cmd.includes('set "DRUCK_ZIELE="\r\n'))
    assert.equal(zielWert('zetteldrucker'), 'zetteldrucker')
    assert.equal(zielWert('drucker; rm -rf'), 'alle')
    assert.equal(zielWert(null), 'alle')
  })

  test('Freitext bricht nicht aus den Skripten aus — Netzwerkdrucker behalten ihre Backslashes', () => {
    assert.equal(skriptSicher('pack"tisch & %PATH% $(x) `y` \'z\'\r\nexit'), 'packtisch & PATH (x) y zexit')
    assert.equal(skriptSicher('\\\\druckserver\\Zebra GK420d'), '\\\\druckserver\\Zebra GK420d')
    const dateien = druckbrueckePaket({ ...ANGABEN, name: 'a"b%c', drucker: "x'$y" })
    const cmd = String(dateien[0].inhalt)
    const sh = String(dateien[2].inhalt)
    assert.ok(cmd.includes('set "DRUCK_AGENT_NAME=abc"\r\n'))
    assert.ok(sh.includes("export DRUCKER='xy'\n"))
  })

  test('Adresse für die PCs: ERP_PUBLIC_URL, sonst der aufgerufene Host — nie die interne URL', () => {
    const kopf = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null })
    assert.equal(
      oeffentlicheAdresse({ ERP_PUBLIC_URL: 'https://erp.anvil.gg/' }, kopf({ host: 'x' }), 'http://localhost:3000'),
      'https://erp.anvil.gg',
    )
    assert.equal(
      oeffentlicheAdresse({}, kopf({ 'x-forwarded-host': 'claude4-one.vercel.app', 'x-forwarded-proto': 'https', host: 'localhost:3000' }), 'http://localhost:3000'),
      'https://claude4-one.vercel.app',
    )
    assert.equal(oeffentlicheAdresse({}, kopf({ host: 'erp.firma.de' }), 'x'), 'https://erp.firma.de')
    assert.equal(oeffentlicheAdresse({}, kopf({ host: '127.0.0.1:3210' }), 'x'), 'http://127.0.0.1:3210')
    assert.equal(oeffentlicheAdresse({}, kopf({}), 'http://localhost:3000'), 'http://localhost:3000')
  })

  test('der echte PowerShell-Agent: nur ASCII, holt je Abruf einen Auftrag, Sumatra mit fester Prüfsumme', async () => {
    const quelle = await readFile(new URL('../scripts/druck-agent.ps1', import.meta.url), 'utf8')
    assert.ok(quelle.length > 1000)
    assert.ok([...quelle].every((zeichen) => zeichen.charCodeAt(0) < 128), 'PowerShell 5.1 liest Skripte ohne BOM als ANSI')
    assert.match(quelle, /'limit=1'/)
    assert.match(quelle, /\$SumatraSha256 = '[0-9A-F]{64}'/)
    assert.match(quelle, /\/api\/druck\/quittieren/)
    const paket = druckbrueckePaket({ ...ANGABEN, agentPsQuelle: quelle })
    const ps1 = String(paket.find((d) => d.name === 'druck-agent.ps1')!.inhalt)
    assert.equal(ps1.replace(/\r\n/g, '\n'), quelle.replace(/\r\n/g, '\n'))
    assert.ok(!/[^\r]\n/.test(ps1), 'nur CRLF')
  })

  test('der echte Node-Agent startet mit den Flags des Startskripts (und verlangt Adresse und Token)', async () => {
    const quelle = await readFile(new URL('../scripts/druck-agent.ts', import.meta.url), 'utf8')
    assert.ok(quelle.length > 1000)
    const lauf = promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'scripts/druck-agent.ts'],
      { env: { ...process.env, KRNL_URL: '', DRUCK_AGENT_TOKEN: '' }, timeout: 20_000 },
    )
    await assert.rejects(lauf, (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1)
      assert.match(err.stderr ?? '', /KRNL_URL und DRUCK_AGENT_TOKEN müssen gesetzt sein/)
      return true
    })
  })
  test('Paket je Drucker (0087): Drucker-ID statt Zielen, eigener Autostart je Drucker', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const dateien = new Map(
      druckbrueckePaket({ ...ANGABEN, name: 'QL Packtisch 1', druckerId: id, drucker: 'Brother QL-1100' })
        .map((d) => [d.name, String(d.inhalt)]),
    )
    const cmd = dateien.get('druckbruecke-starten.cmd')!
    for (const zeile of [
      `set "DRUCK_DRUCKER_ID=${id}"`,
      'set "DRUCK_ZIELE="',
      'set "DRUCKER=Brother QL-1100"',
    ]) {
      assert.ok(cmd.includes(`${zeile}\r\n`), `fehlt: ${zeile}`)
    }
    assert.ok(dateien.get('druckbruecke-starten.sh')!.includes(`export DRUCK_DRUCKER_ID='${id}'`))
    // Zwei Drucker an einem PC dürfen sich die Verknüpfung nicht überschreiben.
    assert.ok(dateien.get('autostart-einrichten.cmd')!.includes('KRNL Druckbruecke QL Packtisch 1.lnk'))
    assert.ok(dateien.get('LIESMICH.txt')!.includes('Einstellungen → Arbeitsplätze → Drucker'))

    // Ohne Drucker-ID bleibt das Alt-Paket mit Zielen.
    const alt = String(druckbrueckePaket(ANGABEN)[0].inhalt)
    assert.ok(alt.includes('set "DRUCK_DRUCKER_ID="\r\n'))
    assert.ok(alt.includes('set "DRUCK_ZIELE=labeldrucker"\r\n'))
  })
})
