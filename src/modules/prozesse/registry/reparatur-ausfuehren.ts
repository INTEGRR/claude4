import { sql, tx } from '@/db/client'
import { dhlConfigured } from '@/modules/versand/dhl'
import { createLabelForRepair, createReturnLabelForPartner } from '@/modules/versand/service'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'
import { kontaktAusAnfrage } from '../../shared/reparaturanfrage.ts'

/** Ausführung der Reparatur-Aktionen — Fachlogik aus reparatur/actions.ts. */

interface Herkunft {
  model: string
  id: string
  label: string
}

/**
 * Der eine Anlage-Kern: Reparaturauftrag mit optionaler Herkunft (Anfrage).
 * Genutzt von auftragAnlegen (frei) und anfrageAnnehmen (Kombi) — kein
 * zweiter Insert-Dialekt.
 */
async function reparaturAnlegen(
  p: { partner_id: string; variant_id: string; qty: number; under_warranty: boolean; note?: string },
  herkunft?: Herkunft,
): Promise<{ id: string; number: string }> {
  const [repair] = await sql<{ id: string; number: string }[]>`
    insert into repair_orders
      (number, partner_id, variant_id, qty, under_warranty, note,
       origin_model, origin_id, origin_label)
    values (next_sequence('repair'), ${p.partner_id}, ${p.variant_id}, ${p.qty},
            ${p.under_warranty}, ${p.note ?? null},
            ${herkunft?.model ?? null}, ${herkunft?.id ?? null}, ${herkunft?.label ?? null})
    returning id, number`
  return repair
}

export async function auftragAnlegen(
  p: { partner_id: string; variant_id: string; qty: number; under_warranty: boolean; note?: string },
): Promise<AktionsErgebnis> {
  const repair = await reparaturAnlegen(p)
  return {
    text: `Reparaturauftrag ${repair.number} angelegt.`,
    link: `/reparatur/${repair.id}`,
    recordId: repair.id,
  }
}

/**
 * Kunde zur Anfrage: per E-Mail wiederverwenden (Kundenkonten zuerst, das
 * älteste gewinnt) oder anlegen. Bei einem bestehenden Kontakt werden
 * Adressfelder nur ERGÄNZT (leere Felder gefüllt), nie überschrieben — die
 * Anfrage ist nicht die bessere Quelle als das Kundenkonto.
 */
async function partnerZurAnfrage(
  kontakt: ReturnType<typeof kontaktAusAnfrage>,
  ctx: AktionsKontext,
): Promise<string> {
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from partners
    where lower(email) = lower(${kontakt.email}) and active
    order by is_customer desc, created_at
    limit 1`
  if (vorhanden) {
    const [ergaenzt] = await sql<{ geaendert: boolean }[]>`
      update partners set
        phone = coalesce(phone, ${kontakt.telefon ?? null}),
        street = coalesce(street, ${kontakt.strasse}),
        house_number = coalesce(house_number, ${kontakt.hausnummer}),
        zip = coalesce(zip, ${kontakt.plz}),
        city = coalesce(city, ${kontakt.ort}),
        is_customer = true
      where id = ${vorhanden.id}
      returning (xmax::text <> '0') as geaendert`
    if (ergaenzt?.geaendert) {
      await sql`select log_event('partner', ${vorhanden.id}, 'note',
        'Kontaktdaten aus einer Reparaturanfrage ergänzt (nur leere Felder)', ${ctx.actor})`
    }
    return vorhanden.id
  }

  const { partnerAnlegen } = await import('./kontakte-ausfuehren.ts')
  const neu = await partnerAnlegen(
    {
      name: kontakt.name,
      is_company: false,
      is_customer: true,
      is_vendor: false,
      email: kontakt.email,
      phone: kontakt.telefon,
      street: kontakt.strasse,
      house_number: kontakt.hausnummer,
      zip: kontakt.plz,
      city: kontakt.ort,
      country_code: kontakt.land,
    },
    ctx,
  )
  return neu.recordId!
}

/**
 * Die Fuge Reparaturanfrage → Reparaturauftrag (Kombi-Aktion): Kunde,
 * Auftrag mit Herkunft und — auf Wunsch — sofort das Retourenlabel. Das
 * Label läuft NACH dem Commit (externer Aufruf nie in der Transaktion);
 * scheitert es, bleibt der Auftrag in 'new', der Grund steht am Auftrag,
 * und „Retourenlabel senden" wird dort erneut angeboten. Idempotent: ein
 * zweiter Klick verlinkt den bestehenden Auftrag (Unique-Index 0081).
 */
export async function anfrageAnnehmen(
  p: {
    state: string
    variant_id: string
    under_warranty: boolean
    qty: number
    label_senden: boolean
    vermerk?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [vorgang] = await sql<
    { number: string; prozess_code: string; partner_id: string | null; zusatz: Record<string, unknown> }[]
  >`
    select number, prozess_code, partner_id, zusatz from vorgaenge where id = ${id}`
  if (!vorgang) throw new Error('Vorgang nicht gefunden.')
  if (vorgang.prozess_code !== 'reparatur_anfrage') {
    throw new Error(`${vorgang.number} ist keine Reparaturanfrage.`)
  }

  const [vorhanden] = await sql<{ id: string; number: string }[]>`
    select id, number from repair_orders where origin_model = 'vorgang' and origin_id = ${id}`
  if (vorhanden) {
    return {
      text: `Reparaturauftrag ${vorhanden.number} existiert bereits zu ${vorgang.number}.`,
      link: `/reparatur/${vorhanden.id}`,
      recordId: id,
    }
  }

  const kontakt = kontaktAusAnfrage(vorgang.zusatz)
  const partnerId = vorgang.partner_id ?? (await partnerZurAnfrage(kontakt, ctx))

  const notiz =
    kontakt.fehlerbeschreibung +
    (kontakt.bestellnummer ? `\nBestellnummer: ${kontakt.bestellnummer}` : '') +
    (p.vermerk ? `\nVermerk bei Annahme: ${p.vermerk}` : '')

  const repair = await tx(async (t) => {
    const [r] = await t<{ id: string; number: string }[]>`
      insert into repair_orders
        (number, partner_id, variant_id, qty, under_warranty, note,
         origin_model, origin_id, origin_label)
      values (next_sequence('repair'), ${partnerId}, ${p.variant_id}, ${p.qty},
              ${p.under_warranty}, ${notiz}, 'vorgang', ${id}, ${vorgang.number})
      returning id, number`
    await t`update vorgaenge set partner_id = ${partnerId}, state = ${p.state} where id = ${id}`
    await t`select log_event('vorgang', ${id}::uuid, 'state',
      ${`Anfrage angenommen — Reparaturauftrag ${r.number}`}, ${ctx.actor})`
    await t`select log_event('repair_order', ${r.id}::uuid, 'state',
      ${`Aus Reparaturanfrage ${vorgang.number} angelegt`}, ${ctx.actor})`
    return r
  })

  let hinweis = ''
  if (p.label_senden) {
    if (!dhlConfigured()) {
      hinweis = ' DHL ist nicht konfiguriert — das Retourenlabel später vom Auftrag aus senden.'
    } else {
      try {
        await retourenlabelSenden({}, { ...ctx, recordId: repair.id })
        hinweis = ' Retourenlabel ist an den Kunden gemailt.'
      } catch (err) {
        const grund = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
        await sql`select log_event('repair_order', ${repair.id}::uuid, 'error',
          ${`Retourenlabel fehlgeschlagen: ${grund.slice(0, 300)}`}, ${ctx.actor})`
        hinweis = ` Retourenlabel fehlgeschlagen: ${grund} — auf dem Auftrag erneut senden.`
      }
    }
  }

  return {
    text: `Reparaturauftrag ${repair.number} angelegt.${hinweis}`,
    link: `/reparatur/${repair.id}`,
    recordId: id,
  }
}

/** Retourenlabel mit der RMA-Nummer als Kundenreferenz; der Auftrag wartet dann auf das Gerät. */
export async function retourenlabelSenden(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [r] = await sql<{ number: string; partner_id: string; state: string }[]>`
    select number, partner_id, state from repair_orders where id = ${id}`
  if (!r) throw new Error('Reparaturauftrag nicht gefunden.')
  if (!['new', 'awaiting_device'].includes(r.state)) {
    throw new Error(`Retourenlabel nur vor dem Geräteeingang möglich (Status ${r.state}).`)
  }
  const label = await createReturnLabelForPartner(r.partner_id, {
    repairOrderId: id,
    reference: r.number,
  })
  await sql`select repair_await_device(${id}, ${ctx.actor})`
  return {
    text: `Retourenlabel ${label.shipmentNumber} erstellt und an den Kunden gemailt.`,
    recordId: id,
  }
}

export async function geraetEingegangen(
  p: { vermerk?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select repair_receive(${ctx.recordId!}, ${ctx.actor}, ${p.vermerk ?? null})`
  return { text: 'Gerät eingegangen — der Auftrag kann bestätigt werden.', recordId: ctx.recordId }
}

/**
 * Rückgabe an den Kunden: DHL-Label aus dem Reparaturauftrag (Sendung ohne
 * Lieferung, Referenz = RMA-Nummer) oder ohne Label (Abholung/Eigenversand).
 * Erst das Label, dann der Status — ein gescheitertes Label lässt den
 * Auftrag repariert stehen, der Grund steht am Beleg.
 */
export async function rueckversandLabel(
  p: { weight_g?: number; dhl_product?: string; ohne_label: boolean; vermerk?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  let text: string
  if (p.ohne_label) {
    await sql`select repair_ship(${id}, ${ctx.actor}, ${p.vermerk ?? 'ohne Versandlabel (Abholung/Eigenversand)'})`
    text = 'Rückgabe ohne Versandlabel vermerkt — der Auftrag ist abgeschlossen.'
  } else {
    let label: Awaited<ReturnType<typeof createLabelForRepair>>
    try {
      label = await createLabelForRepair(id, { weightG: p.weight_g, product: p.dhl_product })
    } catch (err) {
      const grund = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
      await sql`select log_event('repair_order', ${id}::uuid, 'error',
        ${`DHL-Label fehlgeschlagen: ${grund.slice(0, 300)}`}, ${ctx.actor})`
      throw err
    }
    await sql`select repair_ship(${id}, ${ctx.actor}, ${p.vermerk ?? `DHL ${label.shipmentNumber}`})`
    text = `DHL-Label ${label.shipmentNumber} (${label.product}) erstellt — der Auftrag ist versendet.`
  }
  return { text, recordId: id }
}

export async function teilHinzufuegen(
  p: { variant_id: string; qty: number; part_type: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const repairId = ctx.recordId!
  // repair_add_part zieht bei bereits bestätigten Aufträgen die Bewegung
  // sofort nach (samt Reservierung) — Teile lassen sich also auch noch
  // während der laufenden Reparatur erfassen (Migration 0038).
  await sql`select repair_add_part(${repairId}, ${p.variant_id}, ${p.qty},
    ${p.part_type}::repair_part_type, ${ctx.actor})`
  return { recordId: repairId }
}

export async function teilEntfernen(
  p: { part_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const repairId = ctx.recordId!
  const [part] = await sql<{ move_id: string | null }[]>`
    select move_id from repair_parts where id = ${p.part_id} and repair_id = ${repairId}`
  if (part?.move_id) {
    await sql`select move_cancel(${part.move_id})`
  }
  await sql`delete from repair_parts where id = ${p.part_id} and repair_id = ${repairId}`
  return { recordId: repairId }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_confirm(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function beginnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_start(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function abschliessen(
  p: { mengen: Record<string, number> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select repair_end(${ctx.recordId!}, ${sql.json(p.mengen)}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_cancel(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function angebotErstellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ repair_create_quotation: string }[]>`
    select repair_create_quotation(${ctx.recordId!}, ${ctx.actor})`
  const [order] = await sql<{ number: string }[]>`
    select number from sales_orders where id = ${row.repair_create_quotation}`
  return {
    text: `Angebot ${order?.number ?? ''} aus der Reparatur erstellt.`,
    link: `/verkauf/${row.repair_create_quotation}`,
    recordId: row.repair_create_quotation,
  }
}

export async function details(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update repair_orders set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}
