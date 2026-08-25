import type { Sql, TransactionSql } from 'postgres'

/**
 * Das SQL-Werkzeug des KI-Agenten, bewusst ohne App-Abhängigkeiten:
 * Der Datenbank-Client kommt als Parameter, damit die Schutzmechanismen
 * (Sperrliste, Read-only, Zeilenkappung) direkt testbar sind.
 */

export const MAX_ROWS = 500

/** Tabellen/Spalten, die die KI nie sehen darf. */
const GESPERRT = /\b(users|sessions|settings|password_hash|integration_jobs|sprachprotokoll\w*)\b/i

/**
 * Finanztabellen und -funktionen — für Fragende OHNE Finanzen-Berechtigung
 * (Admin oder Befugnis finanzen:zugriff) als zusatzSperre mitgeben. Die
 * Rechte-Entscheidung trifft der Aufrufer (canAccess), dieses Modul bleibt
 * app-frei.
 */
export const FINANZ_SPERRE =
  /\b(bankkonten|kontostaende|zahlungen|zahlplan_raten|zahlplan_\w*|vertraege|vertrag_\w*|darlehen\w*|steuerzahlungen|umsatzplan\w*|finanz_\w*|ust_\w*|vendor_bill_offen)\b/i

export interface SqlErgebnis {
  rows?: Record<string, unknown>[]
  rowCount?: number
  gekappt?: boolean
  error?: string
}

/** Obergrenze für die Textgröße eines Tool-Ergebnisses (~8.000 Tokens). */
export const MAX_ERGEBNIS_ZEICHEN = 30_000

/**
 * Serialisiert ein Abfrageergebnis für das Sprachmodell und kappt
 * zusätzlich nach GRÖSSE: 500 schmale Zeilen sind harmlos, 500 breite
 * Zeilen kosten schnell sechsstellige Tokenzahlen — und hängen danach in
 * jeder Folgerunde des Agenten erneut im Kontext. Gekürzt wird
 * zeilenweise mit Hinweis, damit das Modell aggregiert statt nachzuladen.
 */
export function ergebnisFuerModell(ergebnis: SqlErgebnis): string {
  if (ergebnis.error) return `Fehler: ${ergebnis.error}`
  let zeilen = ergebnis.rows ?? []
  const bauen = (hinweis?: string) =>
    JSON.stringify({
      zeilen: ergebnis.rowCount,
      ...(hinweis
        ? { hinweis }
        : ergebnis.gekappt
          ? { hinweis: `auf ${MAX_ROWS} Zeilen gekappt` }
          : {}),
      daten: zeilen,
    })
  let text = bauen()
  while (text.length > MAX_ERGEBNIS_ZEICHEN && zeilen.length > 1) {
    zeilen = zeilen.slice(0, Math.max(1, Math.floor(zeilen.length / 2)))
    text = bauen(
      `Antwort zu groß — auf die ersten ${zeilen.length} von ${ergebnis.rowCount} Zeilen gekürzt. ` +
        'Bitte aggregieren oder Spalten einschränken.',
    )
  }
  return text
}

/** Führt eine Abfrage schreibgeschützt mit Timeout und Zeilenkappung aus. */
export async function runReadOnlyQuery(
  client: Sql,
  query: string,
  zusatzSperre?: RegExp,
): Promise<SqlErgebnis> {
  if (GESPERRT.test(query)) {
    return {
      error:
        'Diese Abfrage berührt gesperrte Tabellen (Benutzer, Sitzungen, Einstellungen, Jobs). ' +
        'Bitte auf Fachdaten beschränken.',
    }
  }
  if (zusatzSperre?.test(query)) {
    return {
      error:
        'Diese Abfrage berührt Daten, für die dem Fragenden die Berechtigung fehlt ' +
        '(z. B. Finanzen). Bitte ehrlich sagen, dass die Berechtigung fehlt.',
    }
  }
  try {
    const rows = await client.begin('read only', async (tx: TransactionSql) => {
      await tx.unsafe("set local statement_timeout = '10s'")
      return (await tx.unsafe(query)) as unknown as Record<string, unknown>[]
    })
    const gekappt = rows.length > MAX_ROWS
    return {
      rows: gekappt ? rows.slice(0, MAX_ROWS) : rows,
      rowCount: Math.min(rows.length, MAX_ROWS),
      gekappt,
    }
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).replace(/^error: /, '') }
  }
}
