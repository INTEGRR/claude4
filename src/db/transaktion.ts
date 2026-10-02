import type postgres from 'postgres'

/**
 * `max_pipeline: 0` zum Einspreizen in die postgres.js-Optionen (App-Client
 * und Test-Helfer). postgres.js kennt die Option zur Laufzeit, seine Typen
 * (3.4) nicht — daher als `object`, damit die Optionen typgeprüft bleiben.
 */
export const OHNE_PIPELINING: object = { max_pipeline: 0 }

/**
 * Transaktion auf einer reservierten Verbindung — Ersatz für `sql.begin`.
 *
 * Warum nicht `sql.begin`: Der App-Client fährt ohne Pipelining
 * (`max_pipeline: 0`, src/db/client.ts — Supavisor im Transaction-Mode
 * beantwortet eine hinter eine andere gestapelte Abfrage nie, die Seite
 * hängt bis zum 300-s-Timeout). Mit `max_pipeline: 0` ruft postgres.js den
 * internen Reservierungs-Haken von `begin` nicht mehr auf und wirft
 * `UNSAFE_TRANSACTION`. `reserve()` reserviert die Verbindung selbst und
 * arbeitet ihre Abfragen nacheinander ab — BEGIN/COMMIT/ROLLBACK stehen
 * dann hier, ebenso `savepoint` (Tests, Odoo-Import).
 *
 * `modus` wie bei `sql.begin('read only', …)`; nur Buchstaben und Leerzeichen.
 */
export async function transaktion<T>(
  client: postgres.Sql,
  fn: (t: postgres.TransactionSql) => T | Promise<T>,
  modus = '',
): Promise<T> {
  const verbindung = await client.reserve()
  let offen = false
  try {
    await verbindung.unsafe(`begin ${modus.replace(/[^a-z ]/gi, '')}`)
    offen = true
    const t = mitSavepoints(verbindung)
    const ergebnis = await aufloesen(fn(t))
    await verbindung.unsafe('commit')
    offen = false
    return ergebnis
  } catch (fehler) {
    // Ein fehlgeschlagenes ROLLBACK (Verbindung weg) darf den eigentlichen
    // Fehler nicht verdecken.
    if (offen) await verbindung.unsafe('rollback').catch(() => {})
    throw fehler
  } finally {
    verbindung.release()
  }
}

/** Hängt `savepoint` an die reservierte Verbindung — Semantik wie postgres.js. */
function mitSavepoints(verbindung: postgres.ReservedSql): postgres.TransactionSql {
  let zaehler = 0
  const t = verbindung as unknown as postgres.TransactionSql
  const savepoint = async (
    nameOderFn: string | ((sp: postgres.TransactionSql) => unknown),
    fn?: (sp: postgres.TransactionSql) => unknown,
  ) => {
    const arbeit = typeof nameOderFn === 'function' ? nameOderFn : fn
    if (!arbeit) throw new Error('savepoint braucht eine Funktion')
    const zusatz = typeof nameOderFn === 'string' ? `_${nameOderFn.replace(/\W/g, '')}` : ''
    const name = `s${++zaehler}${zusatz}`
    await verbindung.unsafe(`savepoint ${name}`)
    try {
      const ergebnis = await aufloesen(arbeit(t))
      await verbindung.unsafe(`release savepoint ${name}`)
      return ergebnis
    } catch (fehler) {
      await verbindung.unsafe(`rollback to savepoint ${name}`).catch(() => {})
      throw fehler
    }
  }
  Object.assign(t, { savepoint })
  return t
}

/**
 * postgres.js erlaubt als (synchrone) Rückgabe auch ein Array von Abfragen.
 * Bewusst VOR dem await geprüft wie dort: ein async-Callback, der Zeilen
 * liefert, behält seine RowList (count, columns).
 */
async function aufloesen<T>(wert: T | Promise<T>): Promise<T> {
  return (Array.isArray(wert) ? await Promise.all(wert) : await wert) as T
}
