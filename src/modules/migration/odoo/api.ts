/**
 * Odoo per JSON-RPC — NUR LESEND (Migration 0090, Entscheidungslog
 * 2026-09-29). KRNL übernimmt aus dem laufenden Odoo Stücklisten,
 * Komponenten, Lieferanten und Bestände; es schreibt nie zurück. Die Naht
 * ist `odooLesen`: jede andere Methode als die vier lesenden wird vor dem
 * Netz abgewiesen (Wächter: tests/odoo-stuecklisten.test.ts).
 *
 * Zugang (Umgebungsvariablen, Einstellungen → Schnittstellen „Odoo"):
 * ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY (API-Schlüssel des Benutzers:
 * Odoo → Einstellungen → Benutzer → Kontosicherheit). ODOO_FAKE=1 ersetzt
 * Odoo durch eine Attrappe (Tests, Staging).
 */

export const ODOO_LESEMETHODEN = ['search_read', 'read', 'search_count', 'fields_get'] as const
export type Lesemethode = (typeof ODOO_LESEMETHODEN)[number]

const ZEITLIMIT_MS = 30_000
const SEITE = 500

export function odooKonfiguriert(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ODOO_FAKE === '1') return true
  return Boolean(env.ODOO_URL && env.ODOO_DB && env.ODOO_USER && env.ODOO_API_KEY)
}

export function istLesemethode(methode: string): methode is Lesemethode {
  return (ODOO_LESEMETHODEN as readonly string[]).includes(methode)
}

async function rpc(service: string, methode: string, args: unknown[]): Promise<unknown> {
  const basis = (process.env.ODOO_URL ?? '').replace(/\/$/, '')
  const res = await fetch(`${basis}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method: methode, args }, id: 1 }),
    signal: AbortSignal.timeout(ZEITLIMIT_MS),
  })
  if (!res.ok) throw new Error(`Odoo antwortet ${res.status} — ODOO_URL prüfen`)
  const antwort = (await res.json()) as {
    result?: unknown
    error?: { message?: string; data?: { message?: string } }
  }
  if (antwort.error) {
    throw new Error(`Odoo: ${antwort.error.data?.message ?? antwort.error.message ?? 'unbekannter Fehler'}`)
  }
  return antwort.result
}

let anmeldung: { schluessel: string; uid: number } | null = null

async function uid(): Promise<number> {
  const schluessel = `${process.env.ODOO_URL}|${process.env.ODOO_DB}|${process.env.ODOO_USER}`
  if (anmeldung?.schluessel === schluessel) return anmeldung.uid
  const ergebnis = await rpc('common', 'authenticate', [
    process.env.ODOO_DB,
    process.env.ODOO_USER,
    process.env.ODOO_API_KEY,
    {},
  ])
  if (typeof ergebnis !== 'number' || ergebnis <= 0) {
    throw new Error('Odoo-Anmeldung abgelehnt — ODOO_DB, ODOO_USER und ODOO_API_KEY prüfen')
  }
  anmeldung = { schluessel, uid: ergebnis }
  return ergebnis
}

/** Ein lesender Aufruf an Odoo — andere Methoden werden abgewiesen. */
export async function odooLesen<T>(
  modell: string,
  methode: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  if (!istLesemethode(methode)) {
    throw new Error(`Odoo-Methode „${methode}" ist gesperrt — KRNL liest Odoo nur`)
  }
  if (process.env.ODOO_FAKE === '1') {
    const { fakeOdoo } = await import('./odoo-fake.ts')
    return fakeOdoo(modell, methode, args, kwargs) as T
  }
  if (!odooKonfiguriert()) {
    throw new Error('Odoo ist nicht angebunden — ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY setzen')
  }
  return (await rpc('object', 'execute_kw', [
    process.env.ODOO_DB,
    await uid(),
    process.env.ODOO_API_KEY,
    modell,
    methode,
    args,
    kwargs,
  ])) as T
}

/** Alle Treffer einer Suche, seitenweise. */
export async function alleLesen<T>(modell: string, domain: unknown[], felder: string[]): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += SEITE) {
    const seite = await odooLesen<T[]>(modell, 'search_read', [domain], {
      fields: felder,
      limit: SEITE,
      offset,
      order: 'id',
    })
    out.push(...seite)
    if (seite.length < SEITE) return out
  }
}
