/**
 * Macht aus dem, was der VorschlagEditor liefert, wieder einen gültigen
 * prozess_entwerfen-Aufruf: Der Editor zeigt Arrays als Kommastrings und
 * verschachtelte Objekte als JSON-Strings (ehrliche, editierbare Zellen
 * statt „[object Object]") — vor dem Absenden verwandelt diese Funktion die
 * Strings zurück. Bewusst pur und ohne Server-Import: der KI-Chat ruft sie
 * im Browser auf; die harte Validierung bleibt beim Torwächter (zod).
 *
 * Unbekannte Schlüssel bleiben unangetastet, kaputtes JSON bleibt als
 * String stehen (der Torwächter formuliert dann die Fehlermeldung) — hier
 * wird nur zurückverwandelt, nie repariert oder erfunden.
 */

/** Schlüssel, deren Wert eine Liste von Strings ist (Editor: Kommastring). */
const ARRAY_SCHLUESSEL = new Set(['rollen', 'auswahl', 'schritte', 'sichtbar_in'])
/** Schlüssel, deren Wert ein Objekt ist (Editor: JSON-String). */
const OBJEKT_SCHLUESSEL = new Set(['params', 'bedingung', 'teilprozess_link'])
/** Schlüssel, deren Wert ein Schalter ist (Checkbox liefert bool, KI evtl. Text). */
const BOOL_SCHLUESSEL = new Set(['pflicht', 'in_liste', 'optional'])

function alsListe(wert: unknown): unknown {
  if (Array.isArray(wert)) return wert.length ? wert : undefined
  if (typeof wert !== 'string') return wert
  const teile = wert
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
  return teile.length ? teile : undefined
}

function alsObjekt(wert: unknown): unknown {
  if (typeof wert !== 'string') return wert
  const roh = wert.trim()
  if (!roh) return undefined
  try {
    return JSON.parse(roh)
  } catch {
    return wert
  }
}

function alsSchalter(wert: unknown): unknown {
  if (typeof wert === 'boolean') return wert
  if (typeof wert !== 'string') return wert
  const roh = wert.trim().toLowerCase()
  if (['on', 'true', 'ja', '1'].includes(roh)) return true
  if (['', 'off', 'false', 'nein', '0'].includes(roh)) return false
  return wert
}

function zeileNormalisieren(zeile: unknown): unknown {
  if (zeile === null || typeof zeile !== 'object' || Array.isArray(zeile)) return zeile
  const neu: Record<string, unknown> = {}
  for (const [schluessel, wert] of Object.entries(zeile as Record<string, unknown>)) {
    const umgeformt = ARRAY_SCHLUESSEL.has(schluessel)
      ? alsListe(wert)
      : OBJEKT_SCHLUESSEL.has(schluessel)
        ? alsObjekt(wert)
        : BOOL_SCHLUESSEL.has(schluessel)
          ? alsSchalter(wert)
          : wert
    // undefined heißt „kein Wert" — der Schlüssel entfällt, statt als ''
    // oder [] am zod-Schema vorbeizuschrammen.
    if (umgeformt !== undefined) neu[schluessel] = umgeformt
  }
  return neu
}

/** Für die Objektlisten des Entwurfs: schritte, uebergaenge, felder. */
export function normalisiereEntwurf(
  parameter: Record<string, unknown>,
): Record<string, unknown> {
  const neu: Record<string, unknown> = { ...parameter }
  for (const liste of ['schritte', 'uebergaenge', 'felder']) {
    const wert = neu[liste]
    if (Array.isArray(wert)) neu[liste] = wert.map(zeileNormalisieren)
  }
  return neu
}
