import type { ZipDatei } from '../shared/zip.ts'

/**
 * Das Druckbrücken-Paket für EINEN Drucker (0087): die Agenten plus
 * Startskript mit Adresse, Token, Drucker-ID und Windows-Druckername
 * bereits eingetragen, ein Skript für den Autostart und eine Anleitung.
 * Windows läuft seit 2026-09-30 OHNE Node.js: der Agent ist ein
 * PowerShell-Skript (scripts/druck-agent.ps1, auf jedem Windows 10/11
 * lauffähig), das SumatraPDF bei Bedarf portabel nachlädt — auf dem
 * Lagerrechner wird nichts installiert. Linux/macOS nutzen weiter den
 * Node-Agenten (scripts/druck-agent.ts). Download an der
 * Druckerzeile unter Einstellungen → Arbeitsplätze (nur Administratoren,
 * das Paket enthält das Agent-Token). Ohne Drucker-ID entsteht das
 * Alt-Paket je PC mit Zielen (vor 0087).
 *
 * Pur, unter blankem Node testbar. Windows-Skripte mit CRLF und ohne
 * Umlaute (die Konsole liest sie in der OEM-Codepage).
 */

export type DruckZiel = 'labeldrucker' | 'zetteldrucker' | 'alle'

export const DRUCK_ZIELE: { wert: DruckZiel; label: string }[] = [
  { wert: 'labeldrucker', label: 'DHL-Labels' },
  { wert: 'zetteldrucker', label: 'Fertigungszettel (A4)' },
  { wert: 'alle', label: 'Alles (nur ein Drucker)' },
]

export interface PaketAngaben {
  url: string
  token: string
  /** Name des Druckers bzw. (Alt-Paket) des Agenten. */
  name: string
  /** Drucker aus Einstellungen → Arbeitsplätze; dann gilt `ziel` nicht. */
  druckerId?: string | null
  /** Nur Alt-Paket ohne Drucker-ID: welche Aufträge der Agent zieht. */
  ziel: DruckZiel
  /** Druckername wie in Windows; leer = Standarddrucker. */
  drucker: string
  /** Node-Agent (Linux/macOS), unverändert aus scripts/druck-agent.ts. */
  agentQuelle: string
  /** PowerShell-Agent (Windows), unverändert aus scripts/druck-agent.ps1. */
  agentPsQuelle: string
  erstellt: Date
}

/**
 * Freitext für Skripte entschärfen: Anführungszeichen, Prozent, Dollar,
 * Backtick und Steuerzeichen würden in .cmd bzw. .sh aus dem Wert
 * ausbrechen. Backslashes bleiben — Netzwerkdrucker heißen \\server\name.
 */
export function skriptSicher(wert: string, max = 80): string {
  return wert.replace(/["%'`$!\p{Cc}]/gu, '').trim().slice(0, max)
}

/**
 * Die Adresse, unter der die PCs KRNL erreichen: ERP_PUBLIC_URL, sonst der
 * Host, über den der Administrator die Seite gerade aufruft. Hinter Vercel
 * bzw. einem Proxy kommt er aus x-forwarded-host/-proto — die interne
 * request.url kann localhost sein (im Browser-Test gesehen).
 */
export function oeffentlicheAdresse(
  env: Record<string, string | undefined>,
  kopf: { get(name: string): string | null },
  rueckfall: string,
): string {
  const fest = env.ERP_PUBLIC_URL?.trim()
  if (fest) return fest.replace(/\/$/, '')
  const host = (kopf.get('x-forwarded-host') ?? kopf.get('host'))?.split(',')[0].trim()
  if (!host) return rueckfall
  const lokal = /^(localhost|127\.|\[::1\])/.test(host)
  const proto = kopf.get('x-forwarded-proto')?.split(',')[0].trim() || (lokal ? 'http' : 'https')
  return `${proto}://${host}`
}

export function zielWert(wert: string | null | undefined): DruckZiel {
  return wert === 'labeldrucker' || wert === 'zetteldrucker' ? wert : 'alle'
}

const crlf = (zeilen: string[]) => `${zeilen.join('\r\n')}\r\n`

export function druckbrueckePaket(a: PaketAngaben): ZipDatei[] {
  const name = skriptSicher(a.name) || 'druck-pc'
  const drucker = skriptSicher(a.drucker)
  const url = skriptSicher(a.url.replace(/\/$/, ''), 200)
  const token = skriptSicher(a.token, 200)
  const druckerId = a.druckerId ? skriptSicher(a.druckerId, 36) : ''
  const ziele = druckerId || a.ziel === 'alle' ? '' : a.ziel
  const stand = a.erstellt.toISOString().slice(0, 10)

  const starten = crlf([
    '@echo off',
    `rem KRNL Druckbruecke fuer "${name}" - erzeugt von KRNL am ${stand}.`,
    'rem Enthaelt das Agent-Token: nicht weitergeben.',
    `title KRNL Druckbruecke (${name})`,
    'cd /d "%~dp0"',
    `set "KRNL_URL=${url}"`,
    `set "DRUCK_AGENT_TOKEN=${token}"`,
    `set "DRUCK_AGENT_NAME=${name}"`,
    `set "DRUCK_DRUCKER_ID=${druckerId}"`,
    `set "DRUCK_ZIELE=${ziele}"`,
    `set "DRUCKER=${drucker}"`,
    'rem Ohne Node.js: der Agent ist ein PowerShell-Skript (Windows 10/11 hat es).',
    'rem SumatraPDF wird gefunden oder beim ersten Start portabel in diesen Ordner geladen.',
    ':start',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0druck-agent.ps1"',
    'echo Druckbruecke beendet - Neustart in 10 Sekunden ...',
    'timeout /t 10 /nobreak >nul',
    'goto start',
  ])

  const autostart = crlf([
    '@echo off',
    'rem Legt eine Verknuepfung im Autostart-Ordner an: die Druckbruecke startet',
    'rem ab jetzt mit der Windows-Anmeldung (minimiert).',
    // Name in der Verknüpfung: zwei Drucker am selben PC = zwei Autostarts.
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\\KRNL Druckbruecke ${name}.lnk'); $s.TargetPath='%~dp0druckbruecke-starten.cmd'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"`,
    'if errorlevel 1 (echo Autostart konnte nicht eingerichtet werden. & pause & exit /b 1)',
    'echo Autostart eingerichtet. Entfernen: Win+R, shell:startup, Verknuepfung loeschen.',
    'pause',
  ])

  const shell = [
    '#!/bin/sh',
    `# KRNL Druckbrücke für "${name}" — Linux/macOS (Druck über lp). Enthält das Agent-Token.`,
    'cd "$(dirname "$0")"',
    `export KRNL_URL='${url}'`,
    `export DRUCK_AGENT_TOKEN='${token}'`,
    `export DRUCK_AGENT_NAME='${name}'`,
    `export DRUCK_DRUCKER_ID='${druckerId}'`,
    `export DRUCK_ZIELE='${ziele}'`,
    `export DRUCKER='${drucker}'`,
    'while true; do',
    '  node --experimental-strip-types --disable-warning=ExperimentalWarning druck-agent.ts',
    '  echo "Druckbrücke beendet — Neustart in 10 Sekunden …"',
    '  sleep 10',
    'done',
    '',
  ].join('\n')

  const zielText = druckerId
    ? 'die Aufträge des Druckers laut Einstellungen → Arbeitsplätze → Druckwege'
    : (DRUCK_ZIELE.find((z) => z.wert === a.ziel)?.label ?? 'Alles')
  const kontrolle = druckerId
    ? [
        'Kontrolle in KRNL: Einstellungen → Arbeitsplätze → Drucker.',
        `   Bei „${name}" steht unter „zuletzt gesehen" gerade eben.`,
      ]
    : [
        'Kontrolle in KRNL: Einstellungen → Versand & Druck → Druck-Agenten.',
        `   Dort erscheint „${name}" mit dem Zustand „aktiv".`,
      ]
  const liesmich = `\uFEFF${crlf([
    `KRNL Druckbrücke — Paket für „${name}"`,
    `Erzeugt am ${stand} für ${url}`,
    '',
    `Dieser PC druckt: ${zielText}`,
    `Drucker: ${drucker || 'Windows-Standarddrucker'}`,
    '',
    'Einrichtung (einmalig, Windows) — es muss NICHTS installiert werden:',
    '',
    '1. Dieses ZIP entpacken, z. B. nach C:\\KRNL-Druckbruecke',
    '   (Rechtsklick → „Alle extrahieren").',
    '2. „druckbruecke-starten.cmd" doppelklicken. Beim ersten Start lädt die',
    '   Brücke SumatraPDF (druckt die PDFs still) als portable Version in',
    '   diesen Ordner — ist es schon installiert, nimmt sie das installierte.',
    '3. Im Fenster steht „Druckbruecke aktiv" — das Fenster offen lassen',
    '   (minimieren geht). Fragt Windows beim Start nach, „Trotzdem',
    '   ausführen" wählen.',
    ...kontrolle,
    '4. Damit die Brücke nach einem Neustart von selbst läuft:',
    '   „autostart-einrichten.cmd" einmal doppelklicken.',
    '',
    'Druckername ändern: druckbruecke-starten.cmd mit dem Editor öffnen und',
    'die Zeile set "DRUCKER=..." anpassen (Name wie unter Windows →',
    'Einstellungen → Drucker). Leer = Standarddrucker.',
    '',
    'Das Paket enthält das Agent-Token. Nicht weitergeben. Wird das Token in',
    'KRNL geändert, das Paket neu herunterladen.',
    '',
    'Zwei Drucker an einem PC: je Drucker ein eigenes Paket in einen eigenen',
    'Ordner entpacken und beide starten.',
    '',
    'Linux/macOS: druckbruecke-starten.sh (braucht Node.js ≥ 22, druckt über lp).',
  ])}`

  return [
    { name: 'druckbruecke-starten.cmd', inhalt: starten },
    { name: 'autostart-einrichten.cmd', inhalt: autostart },
    { name: 'druckbruecke-starten.sh', inhalt: shell },
    { name: 'LIESMICH.txt', inhalt: liesmich },
    // PowerShell 5.1 liest .ps1 ohne BOM in der ANSI-Codepage — das Skript
    // ist reines ASCII, mit CRLF wie die .cmd.
    { name: 'druck-agent.ps1', inhalt: crlf(a.agentPsQuelle.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) },
    { name: 'druck-agent.ts', inhalt: a.agentQuelle },
    // Ohne diese Angabe rät Node den Modultyp und warnt bei jedem Start.
    { name: 'package.json', inhalt: '{ "type": "module", "private": true }\n' },
  ]
}
