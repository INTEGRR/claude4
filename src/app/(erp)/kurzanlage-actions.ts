'use server'
import { sql } from '@/db/client'
import { kontaktAusKurzanlage } from '@/modules/kontakte/kurzanlage'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, actionError, actionInfo, isActionError } from '@/modules/shared/action'

/**
 * Kurzanlage aus der Auswahlbox (src/components/kurzanlage-typen.ts): je
 * Thema ein dünner Wrapper um die vorhandene Registry-Aktion — angelegt wird
 * über den Torwächter wie überall, zurück kommt die neue Option
 * (`daten: { id, text }`), damit die Box sie sofort auswählt.
 */

function wert(werte: Record<string, string>, name: string): string | undefined {
  const v = (werte[name] ?? '').trim()
  return v || undefined
}

function neueId(r: ActionResult): string | undefined {
  const daten = r && 'daten' in r ? r.daten : undefined
  return typeof daten?.recordId === 'string' ? daten.recordId : undefined
}

/** Lieferant, Spediteur oder Kunde — Firma oder Person aus einem Namensfeld. */
export async function kontaktKurzAnlegen(
  rolle: 'kunde' | 'lieferant',
  werte: Record<string, string>,
): Promise<ActionResult> {
  const kontakt = kontaktAusKurzanlage(rolle, werte)
  if ('fehler' in kontakt) return actionError(kontakt.fehler)
  const r = await serverAktion('kontakte.partner_anlegen', { parameter: kontakt, mitBeleg: true })
  if (isActionError(r)) return r
  const id = neueId(r)
  if (!id) return actionError('Kontakt angelegt, aber ohne ID zurück — bitte Seite neu laden')
  const text = kontakt.name ?? [kontakt.vorname, kontakt.nachname].filter(Boolean).join(' ')
  return actionInfo(`„${text}" angelegt`, `/kontakte/${id}`, { id, text })
}

/**
 * Artikel ohne Varianten — für Einkauf (einkaufbar) oder Verkauf. Die
 * Auswahllisten zeigen Varianten; zurück kommt deshalb die eine Variante.
 */
export async function artikelKurzAnlegen(
  zweck: 'einkauf' | 'verkauf',
  werte: Record<string, string>,
): Promise<ActionResult> {
  const name = wert(werte, 'name')
  if (!name) return actionError('Bitte einen Namen angeben')
  const sku = wert(werte, 'sku')
  const r = await serverAktion('produkte.produkt_anlegen', {
    parameter: {
      name,
      sku,
      einkaufbar: zweck === 'einkauf',
      verkaufbar: zweck === 'verkauf',
      ...(zweck === 'einkauf' ? { route: 'kaufen' } : {}),
    },
    mitBeleg: true,
  })
  if (isActionError(r)) return r
  const templateId = neueId(r)
  const [variante] = templateId
    ? await sql<{ id: string }[]>`
        select id from product_variants where template_id = ${templateId} order by created_at limit 1`
    : []
  if (!variante) return actionError('Artikel angelegt, aber ohne Variante — bitte Seite neu laden')
  const text = sku ? `${name} · ${sku}` : name
  return actionInfo(`„${name}" angelegt`, `/produkte/${templateId}`, { id: variante.id, text })
}

/** Produktkategorie (nur Admin — wie in den Einstellungen). */
export async function kategorieKurzAnlegen(werte: Record<string, string>): Promise<ActionResult> {
  const name = wert(werte, 'name')
  if (!name) return actionError('Bitte einen Namen angeben')
  const r = await serverAktion('einstellungen.kategorie_anlegen', { parameter: { name }, mitBeleg: true })
  if (isActionError(r)) return r
  const id = neueId(r)
  if (!id) return actionError('Kategorie angelegt, aber ohne ID zurück — bitte Seite neu laden')
  return actionInfo(`„${name}" angelegt`, undefined, { id, text: name })
}
