/**
 * Fortschrittsspur der Prozesstests — und ein Wachhund.
 *
 * Warum eine eigene Datei: Die bisherige Spur saß IM Harness und hat den
 * CI-Hänger damit nur zur Hälfte verortet. Der letzte Lauf zeigte, dass
 * `prozess-harness.log` überhaupt nicht entsteht — der Hänger liegt also vor
 * der ersten Harness-Zeile: entweder verlässt der Prozess der VORIGEN
 * Testdatei die Bühne nicht (node:test wartet bei --test-concurrency=1 auf
 * sein Ende), oder der Import-Baum der nächsten Datei bleibt stecken.
 *
 * Diese Datei wird deshalb als ERSTES importiert und schreibt
 *   - beim Laden, wer läuft,
 *   - beim Beenden, dass er fertig ist,
 *   - und alle 10 Sekunden, WORAUF der Prozess wartet.
 *
 * Der Wachhund ist bewusst unref(): er hält den Prozess nicht am Leben (sonst
 * würde er den Fehler erzeugen, den er sucht), feuert aber, solange irgendein
 * anderer Handle die Ereignisschleife offen hält — also genau im Hängerfall.
 * `getActiveResourcesInfo()` benennt diese Handles beim Namen.
 */
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

const DATEI = basename(process.argv[1] ?? 'unbekannt')

/** In der CI immer, lokal auf Wunsch (HARNESS_SPUR=1). */
const SCHREIBEN = Boolean(process.env.CI) || process.env.HARNESS_SPUR === '1'

export function spur(text: string): void {
  const zeile = `[${DATEI}] ${text}\n`
  process.stderr.write(zeile)
  // node:test sammelt die Ausgabe der Kindprozesse und gibt sie erst aus,
  // wenn eine Testdatei FERTIG ist — bei einem Hänger also nie. Die Datei
  // überlebt auch einen Abbruch und wird vom Workflow ausgegeben.
  if (SCHREIBEN) {
    try {
      appendFileSync('prozess-harness.log', zeile)
    } catch {
      // Eine unschreibbare Spur darf keinen Lauf kippen.
    }
  }
}

if (SCHREIBEN) {
  spur('geladen')
  const wachhund = setInterval(() => {
    spur(`wartet noch — offene Handles: ${process.getActiveResourcesInfo().join(', ') || 'keine'}`)
  }, 10_000)
  wachhund.unref()
  process.on('exit', (code) => spur(`Prozess endet (Code ${code})`))
}
