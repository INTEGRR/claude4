import { sql } from '@/db/client'

/**
 * Einen settings-Schlüssel lesen — jede Einstellungsseite liest nur, was sie
 * zeigt (statt die ganze Tabelle). Fehlt der Schlüssel, kommt ein leeres
 * Objekt; die Seiten setzen ihre Vorgaben selbst.
 */
export async function einstellung<T extends object>(key: string): Promise<Partial<T>> {
  const [row] = await sql<{ value: Partial<T> | null }[]>`select value from settings where key = ${key}`
  return row?.value ?? {}
}
