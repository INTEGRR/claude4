import { sql } from '@/db/client'
import { DOKUMENT_MODELLE, type DokumentModell, ordnerName } from '../einkauf/dokument-modelle.ts'
import { googleFake } from './auth.ts'
import { drive } from './drive.ts'

/**
 * Ordnerbaum der geteilten Ablage „Einkauf" (0092): Lieferanten/<Name>/
 * <Bestellnummer>, Lieferanten/<Name>/Rechnungen, Artikel/<Name>, Eingang
 * (Mail-Anhänge ohne Zuordnung).
 * Jeder Ordner entsteht genau einmal — `drive_ordner` merkt ihn sich; fehlt
 * der Eintrag (z. B. nach „Betriebsdaten löschen"), wird erst nach einem
 * gleichnamigen Ordner gesucht statt einen zweiten anzulegen.
 */

export const FAKE_WURZEL = 'fake-ablage-einkauf'

const BEREICHE = {
  lieferanten: 'Lieferanten',
  projekte: 'Projekte',
  artikel: 'Artikel',
  eingang: 'Eingang',
} as const

export function ablageWurzel(): string {
  if (googleFake()) return FAKE_WURZEL
  const id = process.env.GOOGLE_EINKAUF_ABLAGE_ID
  if (!id) throw new Error('Google-Ablage fehlt — GOOGLE_EINKAUF_ABLAGE_ID setzen')
  return id
}

export async function ordnerSichern(schluessel: string, name: string, elternId: string): Promise<string> {
  const [da] = await sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = ${schluessel}`
  if (da) return da.folder_id
  const api = await drive()
  const id = (await api.ordnerFinden(name, elternId)) ?? (await api.ordnerAnlegen(name, elternId))
  await sql`insert into drive_ordner (schluessel, folder_id, name) values (${schluessel}, ${id}, ${name})
            on conflict (schluessel) do nothing`
  const [r] = await sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = ${schluessel}`
  return r.folder_id
}

export async function bereichsOrdner(bereich: keyof typeof BEREICHE): Promise<string> {
  return ordnerSichern(`wurzel:${bereich}`, BEREICHE[bereich], ablageWurzel())
}

/** Legt die Hauptordner an (idempotent) — Einrichtungs-Aktion. */
export async function ablageEinrichten(): Promise<string[]> {
  const namen: string[] = []
  for (const b of Object.keys(BEREICHE) as (keyof typeof BEREICHE)[]) {
    await bereichsOrdner(b)
    namen.push(BEREICHE[b])
  }
  return namen
}

async function lieferantenOrdner(partnerId: string): Promise<string> {
  const [p] = await sql<{ name: string }[]>`select name from partners where id = ${partnerId}`
  if (!p) throw new Error('Lieferant nicht gefunden')
  return ordnerSichern(`partner:${partnerId}`, ordnerName(p.name), await bereichsOrdner('lieferanten'))
}

/** Wohin eine Datei zu diesem Beleg gehört. */
export async function zielOrdner(modell: DokumentModell, recordId: string): Promise<string> {
  switch (modell) {
    case 'partner':
      return lieferantenOrdner(recordId)
    case 'purchase_order': {
      const [po] = await sql<{ number: string; vendor_id: string }[]>`
        select number, vendor_id from purchase_orders where id = ${recordId}`
      if (!po) throw new Error('Bestellung nicht gefunden')
      return ordnerSichern(`purchase_order:${recordId}`, ordnerName(po.number), await lieferantenOrdner(po.vendor_id))
    }
    case 'vendor_bill': {
      const [b] = await sql<{ vendor_id: string }[]>`select vendor_id from vendor_bills where id = ${recordId}`
      if (!b) throw new Error('Rechnung nicht gefunden')
      return ordnerSichern(`rechnungen:${b.vendor_id}`, 'Rechnungen', await lieferantenOrdner(b.vendor_id))
    }
    case 'product_template': {
      const [t] = await sql<{ name: string }[]>`select name from product_templates where id = ${recordId}`
      if (!t) throw new Error('Artikel nicht gefunden')
      return ordnerSichern(`product_template:${recordId}`, ordnerName(t.name), await bereichsOrdner('artikel'))
    }
    case 'mail_thread': {
      // Anhänge und Screenshots eines Threads: in den Ordner seiner Bestellung
      // bzw. seines Lieferanten — solange er niemandem zugeordnet ist, in den
      // Eingang (beim Zuordnen zieht die Datei um).
      const [t] = await sql<{ partner_id: string | null; purchase_order_id: string | null }[]>`
        select partner_id, purchase_order_id from mail_threads where id = ${recordId}`
      if (!t) throw new Error('Mail-Thread nicht gefunden')
      if (t.purchase_order_id) return zielOrdner('purchase_order', t.purchase_order_id)
      if (t.partner_id) return lieferantenOrdner(t.partner_id)
      return bereichsOrdner('eingang')
    }
    default: {
      const _nie: never = modell
      throw new Error(`Unbekannter Beleg ${String(_nie)} — erlaubt: ${Object.keys(DOKUMENT_MODELLE).join(', ')}`)
    }
  }
}
