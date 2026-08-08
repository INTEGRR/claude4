/**
 * Ergebnis einer Server Action.
 *
 * Hintergrund: Next.js schwärzt in Produktionsbauten jeden Fehler, der aus
 * einer Server Action geworfen wird — beim Client kommt nur noch eine
 * React-Fehlernummer an. Fachliche Meldungen wie „Erledigte Transfers können
 * nicht storniert werden" sind aber genau das, was die Bedienung braucht.
 *
 * Deshalb gilt im ganzen Haus: fachliche Fehler werden **zurückgegeben**,
 * nicht geworfen. `ActionButton` und `ActionForm` zeigen sie an. Geworfen
 * wird nur noch, was wirklich ein Programmfehler ist.
 */
export type ActionResult = void | { error: string } | { info: string; link?: string }

/** Fachlicher Fehler mit fester Meldung. */
export function actionError(message: string): { error: string } {
  return { error: message }
}

/**
 * Fehler aus der Datenbank in eine Meldung übersetzen. Das Präfix „error: "
 * von postgres.js fällt weg — übrig bleibt der Text, den die SQL-Funktion
 * mit `raise exception` formuliert hat.
 */
export function actionFail(err: unknown): { error: string } {
  const raw = err instanceof Error ? err.message : String(err)
  return { error: raw.replace(/^error: /, '') }
}

/**
 * Erfolgsmeldung. Nötig, wo eine Aktion etwas anlegt, das nicht auf derselben
 * Seite auftaucht — ein Knopf, nach dem sichtbar nichts passiert, wirkt kaputt,
 * auch wenn er seine Arbeit getan hat.
 */
export function actionInfo(text: string, link?: string): { info: string; link?: string } {
  return { info: text, ...(link ? { link } : {}) }
}

/** Typwächter für die Oberfläche. */
export function isActionError(result: unknown): result is { error: string } {
  return typeof result === 'object' && result !== null && 'error' in result
}

export function isActionInfo(result: unknown): result is { info: string; link?: string } {
  return typeof result === 'object' && result !== null && 'info' in result
}
