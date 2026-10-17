import { sql, tx } from '@/db/client'
import { dhlConfigured } from '@/modules/versand/dhl'
import { createReturnLabelForPartner } from '@/modules/versand/service'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/**
 * Retouren (0119): dünne Hüllen um die SQL-Funktionen retoure_*. Die
 * Fachregeln (Mengen, Statusfolge, Rückbuchung, Fertigung schließen) leben in
 * der Datenbank, damit Portal, Webhook und Knopf dieselben Regeln treffen.
 */

const link = (id: string) => `/versand/retouren/${id}`

async function nummer(id: string): Promise<string> {
  const [r] = await sql<{ nummer: string }[]>`select nummer from retouren where id = ${id}`
  if (!r) throw new Error('Retoure nicht gefunden.')
  return r.nummer
}

export async function retoureAnlegen(
  p: { positionen: { zeile: string; menge: number; grund?: string }[]; grund?: string; email?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [r] = await sql<{ id: string }[]>`
    select retoure_anlegen(${ctx.recordId!}, ${sql.json(p.positionen as never)}, 'intern',
                           ${p.grund ?? null}, ${p.email ?? null}, null, ${ctx.actor}) as id`
  return { text: `Retoure ${await nummer(r.id)} angelegt.`, link: link(r.id), recordId: r.id }
}

/**
 * Label mit der Retourennummer als Referenz; Absender ist die Lieferadresse
 * der Bestellung (dort steht der Kunde wirklich), Mail an die Adresse der
 * Anfrage bzw. der Bestellung.
 */
export async function retoureLabelSenden(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [r] = await sql<
    {
      nummer: string
      status: string
      partner_id: string
      sales_order_id: string
      name: string | null
      street: string | null
      house_number: string | null
      zip: string | null
      city: string | null
      country_code: string | null
      email: string | null
    }[]
  >`
    select r.nummer, r.status::text as status, r.partner_id, r.sales_order_id,
           coalesce(so.ship_name, p.name) as name, coalesce(so.ship_street, p.street) as street,
           coalesce(so.ship_house_number, p.house_number) as house_number,
           coalesce(so.ship_zip, p.zip) as zip, coalesce(so.ship_city, p.city) as city,
           coalesce(so.ship_country_code, p.country_code, 'DE') as country_code,
           coalesce(r.email, so.ship_email, p.email) as email
    from retouren r
    join sales_orders so on so.id = r.sales_order_id
    join partners p on p.id = r.partner_id
    where r.id = ${id}`
  if (!r) throw new Error('Retoure nicht gefunden.')
  if (r.status !== 'genehmigt') {
    throw new Error(`Das Retourenlabel gibt es zur genehmigten Retoure (${r.nummer} steht auf „${r.status}").`)
  }
  // Fehler landen im Verlauf (Labelkarte zeigt den letzten) — egal ob beim
  // Genehmigen oder über „Retourenlabel senden" ausgelöst.
  const label = await createReturnLabelForPartner(r.partner_id, {
    retoureId: id,
    salesOrderId: r.sales_order_id,
    reference: r.nummer,
    absender: {
      name: r.name ?? 'Kunde',
      street: r.street,
      house_number: r.house_number,
      zip: r.zip,
      city: r.city,
      country_code: r.country_code ?? 'DE',
      email: r.email,
    },
  }).catch(async (err: unknown) => {
    const grund = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    await sql`select log_event('retoure', ${id}::uuid, 'error',
      ${`Retourenlabel fehlgeschlagen: ${grund.slice(0, 300)}`}, ${ctx.actor})`
    throw new Error(grund)
  })
  await sql`select log_event('retoure', ${id}::uuid, 'note',
    ${`Retourenlabel ${label.shipmentNumber} erstellt, Mail in der Warteschlange`}, ${ctx.actor})`
  return { text: `Retourenlabel ${label.shipmentNumber} erstellt und an den Kunden gemailt.`, recordId: id }
}

export async function retoureGenehmigen(p: { label_senden: boolean }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`select retoure_genehmigen(${id}, ${ctx.actor})`
  const nr = await nummer(id)
  let hinweis = ''
  if (p.label_senden) {
    if (!dhlConfigured()) {
      hinweis = ' DHL ist nicht konfiguriert — das Retourenlabel später am Beleg senden.'
    } else {
      try {
        await retoureLabelSenden({}, ctx)
        hinweis = ' Retourenlabel ist an den Kunden gemailt.'
      } catch (err) {
        const grund = err instanceof Error ? err.message : String(err)
        hinweis = ` Retourenlabel fehlgeschlagen: ${grund} — am Beleg erneut senden.`
      }
    }
  }
  return { text: `Retoure ${nr} genehmigt.${hinweis}`, recordId: id, link: link(id) }
}

export async function retoureAblehnen(p: { grund: string; mail: boolean }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await tx(async (t) => {
    await t`select retoure_ablehnen(${id}, ${p.grund}, ${ctx.actor})`
    if (p.mail) await t`select enqueue_job('send_return_rejected_email', ${t.json({ retoure_id: id })}, ${`retoure-abgelehnt:${id}`})`
  })
  return { text: `Retoure ${await nummer(id)} abgelehnt${p.mail ? ' — der Kunde bekommt die Begründung per Mail' : ''}.`, recordId: id }
}

export async function retoureEingang(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`select retoure_eingang(${id}, ${ctx.actor})`
  return { text: `Retoure ${await nummer(id)}: Ware eingegangen — jetzt prüfen.`, recordId: id }
}

export async function retourePruefen(
  p: { ergebnisse: { position: string; pruefung: string; notiz?: string }[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [b] = await sql<{ picking: string }[]>`
    select retoure_pruefen(${id}, ${sql.json(p.ergebnisse as never)}, ${ctx.actor}) as picking`
  const [r] = await sql<{ nummer: string; status: string; fertigung_info: string | null; transfer: string | null }[]>`
    select r.nummer, r.status::text as status, r.fertigung_info, sp.number as transfer
    from retouren r left join stock_pickings sp on sp.id = ${b.picking} where r.id = ${id}`
  const abgeschlossen = r.status === 'abgeschlossen'
  return {
    recordId: id,
    text:
      `Retoure ${r.nummer} geprüft, Rück-Transfer ${r.transfer ?? ''} gebucht.` +
      (abgeschlossen
        ? ` Der Shop hatte schon erstattet — abgeschlossen${r.fertigung_info ? `: ${r.fertigung_info}` : ''}.`
        : ' Abgeschlossen wird, sobald der Shop erstattet.'),
  }
}

export async function retoureAbschliessen(_p: { erstattung_bestaetigt: boolean }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [r] = await sql<{ info: string }[]>`select retoure_abschliessen(${id}, ${ctx.actor}) as info`
  return { text: `Retoure ${await nummer(id)} abgeschlossen — ${r.info}.`, recordId: id }
}

export async function retoureStornieren(p: { grund?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`select retoure_stornieren(${id}, ${p.grund ?? null}, ${ctx.actor})`
  return { text: `Retoure ${await nummer(id)} storniert.`, recordId: id }
}
