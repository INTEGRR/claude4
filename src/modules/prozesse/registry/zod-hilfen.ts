import { z } from 'zod'

/**
 * Meldungen der Eingabeprüfung auf Deutsch („Ungültige Eingabe: erwartet
 * Zahl …") — überall dort, wo ein Feld keine eigene Meldung trägt. Gilt
 * global; die Registry lädt dieses Modul, bevor irgendeine Aktion prüft.
 */
z.config(z.locales.de())

/**
 * Hilfen für zod 4 (Umstieg 2026-11-13, Entscheidungslog).
 *
 * `error` am Schema gilt in zod 4 für ALLE Prüfungen des Feldes, auch für
 * `.min()`/`.max()` ohne eigene Meldung. `typFehler` beschränkt die Meldung
 * auf den Typfehler — das, was in zod 3 `invalid_type_error` war: „keine
 * Zahl" bleibt „Bitte eine Zahl angeben", „zu klein" behält seine eigene
 * Meldung. Ein fehlender Wert zählt als Typfehler.
 */
export const typFehler =
  (meldung: string) =>
  (issue: { code?: string }): string | undefined =>
    issue.code === 'invalid_type' ? meldung : undefined

/**
 * Alle Felder optional, OHNE Standardwerte — für „ändern"-Aktionen, bei
 * denen ein fehlendes Feld „bleibt, wie es ist" heißt. In zod 4 füllt
 * `.partial()` Standardwerte auch in optionalen Feldern (ein fehlendes
 * `werkzeugkosten` würde zu 0 und überschriebe den gespeicherten Wert);
 * deshalb wird die Vorgabe hier ausdrücklich abgelegt.
 */
export function ohneVorgaben<T extends Record<string, z.ZodType>>(felder: T) {
  return Object.fromEntries(
    Object.entries(felder).map(([name, feld]) => [name, ((feld instanceof z.ZodDefault ? feld.unwrap() : feld) as z.ZodType).optional()]),
  ) as { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I> ? I : T[K]> }
}
