import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/**
 * Ausführung der Finanz-Aktionen — dünne Wrapper um die SQL-Funktionen aus
 * Migration 0058 (zahlung_erfassen, zahlung_stornieren, zahlplan_*): die
 * Fachlogik (Kurs einfrieren, Deckung prüfen, paid-Flip, Anrechnung) lebt in
 * der Datenbank, hier wird nur aufgerufen und verlinkt.
 */

export async function bankkontoAnlegen(
  p: { name: string; iban?: string; waehrung: string },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string }[]>`
    insert into bankkonten (name, iban, waehrung)
    values (${p.name}, ${p.iban ?? null}, ${p.waehrung})
    returning id`
  return { recordId: row.id, text: `Bankkonto „${p.name}" angelegt.`, link: '/finanzen' }
}

export async function kontostandErfassen(
  p: { bankkonto_id: string; stichtag: string; saldo: number; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into kontostaende (bankkonto_id, stichtag, saldo, notiz, erfasst_von)
    values (${p.bankkonto_id}, ${p.stichtag}, ${p.saldo}, ${p.notiz ?? null}, ${ctx.actor})
    on conflict (bankkonto_id, stichtag)
    do update set saldo = excluded.saldo, notiz = excluded.notiz, erfasst_von = excluded.erfasst_von`
  return { text: 'Kontostand erfasst.', link: '/finanzen' }
}

export async function zahlungErfassen(
  p: {
    richtung: 'ein' | 'aus'
    betrag: number
    waehrung: string
    gezahlt_am?: string
    bankkonto_id?: string
    verwendungszweck?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string }[]>`
    select zahlung_erfassen(
      ${p.richtung}, ${p.betrag}, ${p.waehrung},
      ${p.gezahlt_am ?? sql`current_date`}, ${p.bankkonto_id ?? null},
      'manuell', null, ${p.verwendungszweck ?? null}, ${ctx.actor}) as id`
  return { recordId: row.id, text: 'Zahlung erfasst.', link: '/finanzen' }
}

export async function zahlungStornieren(
  p: { zahlung_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select zahlung_stornieren(${p.zahlung_id}, ${ctx.actor})`
  return { text: 'Zahlung storniert.' }
}

export async function rechnungTeilzahlung(
  p: { betrag: number; gezahlt_am?: string; bankkonto_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    select zahlung_erfassen(
      'aus', ${p.betrag}, 'EUR',
      ${p.gezahlt_am ?? sql`current_date`}, ${p.bankkonto_id ?? null},
      'vendor_bill', ${ctx.recordId!}, null, ${ctx.actor})`
  const [offen] = await sql<{ offen: number }[]>`
    select vendor_bill_offen(${ctx.recordId!}) as offen`
  return {
    recordId: ctx.recordId,
    text:
      Number(offen.offen) <= 0
        ? 'Zahlung erfasst — die Rechnung ist vollständig bezahlt.'
        : `Zahlung erfasst — noch offen: ${Number(offen.offen).toFixed(2)} €.`,
  }
}

export async function poZahlplanSetzen(
  p: {
    anzahlung_pct: number
    rest_ausloeser: 'verschiffung' | 'ankunft' | 'termin'
    rest_termin?: string
    rest_versatz_tage: number
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  if (p.rest_ausloeser === 'termin' && !p.rest_termin) {
    throw new Error('Für den Auslöser „Termin" bitte ein Datum angeben')
  }
  const bezahlt = await sql<{ n: number }[]>`
    select count(*)::int as n from zahlplan_raten
    where purchase_order_id = ${ctx.recordId!} and bezahlt_am is not null`
  if (bezahlt[0].n > 0) {
    throw new Error(
      'Der Zahlplan enthält bereits bezahlte Raten — bitte einzelne Raten ergänzen statt neu aufzusetzen',
    )
  }
  await sql`delete from zahlplan_raten where purchase_order_id = ${ctx.recordId!}`
  if (p.anzahlung_pct > 0 && p.anzahlung_pct < 100) {
    await sql`
      insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
      values (${ctx.recordId!}, 10, ${`Anzahlung ${p.anzahlung_pct} %`}, ${p.anzahlung_pct}, 'bestellung')`
  }
  const restPct = 100 - Math.min(p.anzahlung_pct, 100)
  const restAnteil = p.anzahlung_pct >= 100 ? 100 : restPct
  await sql`
    insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct,
                                ausloeser, versatz_tage, termin)
    values (${ctx.recordId!}, 20,
            ${restAnteil >= 100 ? 'Gesamtbetrag' : `Rest ${restAnteil} %`},
            ${restAnteil},
            ${p.anzahlung_pct >= 100 ? 'bestellung' : p.rest_ausloeser},
            ${p.rest_versatz_tage}, ${p.rest_termin ?? null})`
  const [warnung] = await sql<{ w: string | null }[]>`
    select zahlplan_pruefen(${ctx.recordId!}) as w`
  return {
    recordId: ctx.recordId,
    text: warnung.w ?? 'Zahlplan gesetzt.',
  }
}

export async function zahlplanRateHinzufuegen(
  p: {
    bezeichnung: string
    anteil_pct?: number
    betrag?: number
    ausloeser: 'bestellung' | 'verschiffung' | 'ankunft' | 'termin'
    versatz_tage: number
    termin?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  if ((p.anteil_pct == null) === (p.betrag == null)) {
    throw new Error('Bitte entweder einen Anteil in Prozent ODER einen festen Betrag angeben')
  }
  if (p.ausloeser === 'termin' && !p.termin) {
    throw new Error('Für den Auslöser „Termin" bitte ein Datum angeben')
  }
  await sql`
    insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, betrag,
                                ausloeser, versatz_tage, termin)
    values (${ctx.recordId!},
            coalesce((select max(sequence) from zahlplan_raten where purchase_order_id = ${ctx.recordId!}), 0) + 10,
            ${p.bezeichnung}, ${p.anteil_pct ?? null}, ${p.betrag ?? null},
            ${p.ausloeser}, ${p.versatz_tage}, ${p.termin ?? null})`
  const [warnung] = await sql<{ w: string | null }[]>`
    select zahlplan_pruefen(${ctx.recordId!}) as w`
  return { recordId: ctx.recordId, text: warnung.w ?? 'Rate ergänzt.' }
}

export async function zahlplanRateEntfernen(
  p: { rate_id: string },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const rows = await sql`
    delete from zahlplan_raten where id = ${p.rate_id} and bezahlt_am is null returning id`
  if (rows.length === 0) {
    throw new Error('Die Rate existiert nicht oder ist bereits bezahlt')
  }
  return { text: 'Rate entfernt.' }
}

export async function rateZahlen(
  p: { rate_id: string; gezahlt_am?: string; bankkonto_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [rate] = await sql<
    { betrag_eur: number; waehrung: string; betrag_roh: number; po: string }[]
  >`
    select zahlplan_betrag(r) as betrag_eur,
           po.currency as waehrung,
           round(coalesce(r.betrag, t.gross * r.anteil_pct / 100), 2) as betrag_roh,
           po.id as po
    from zahlplan_raten r
    join purchase_orders po on po.id = r.purchase_order_id
    cross join lateral purchase_order_total(po.id) t
    where r.id = ${p.rate_id}`
  if (!rate) throw new Error('Unbekannte Zahlplan-Rate')
  await sql`
    select zahlung_erfassen(
      'aus', ${rate.betrag_roh}, ${rate.waehrung},
      ${p.gezahlt_am ?? sql`current_date`}, ${p.bankkonto_id ?? null},
      'po_rate', ${p.rate_id}, null, ${ctx.actor})`
  return { recordId: rate.po, text: 'Rate bezahlt.', link: `/einkauf/${rate.po}` }
}

export async function verschiffungErfassen(
  p: { verschifft_am: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update purchase_orders set verschifft_am = ${p.verschifft_am} where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId, text: 'Verschiffungstag erfasst.' }
}

// --- Fixkosten-Verträge (0059) ----------------------------------------------

interface VertragsFelder {
  name: string
  kategorie: string
  partner_id?: string
  betrag: number
  waehrung: string
  intervall: 'monatlich' | 'quartalsweise' | 'jaehrlich'
  zahltag: number
  beginn: string
  ende?: string
  laufzeit_monate?: number
  kuendigungsfrist_monate: number
  notiz?: string
}

export async function vertragAnlegen(
  p: VertragsFelder,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string; nummer: string }[]>`
    insert into vertraege (nummer, name, kategorie, partner_id, betrag, waehrung,
                           intervall, zahltag, beginn, ende, laufzeit_monate,
                           kuendigungsfrist_monate, notiz)
    values (next_sequence('vertrag'), ${p.name}, ${p.kategorie}, ${p.partner_id ?? null},
            ${p.betrag}, ${p.waehrung}, ${p.intervall}, ${p.zahltag}, ${p.beginn},
            ${p.ende ?? null}, ${p.laufzeit_monate ?? null},
            ${p.kuendigungsfrist_monate}, ${p.notiz ?? null})
    returning id, nummer`
  await sql`select log_event('vertrag', ${row.id}, 'state', 'Vertrag angelegt', ${ctx.actor})`
  return {
    recordId: row.id,
    text: `Vertrag ${row.nummer} angelegt.`,
    link: `/finanzen/vertraege/${row.id}`,
  }
}

export async function vertragAendern(
  p: VertragsFelder,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update vertraege set
      name = ${p.name}, kategorie = ${p.kategorie}, partner_id = ${p.partner_id ?? null},
      betrag = ${p.betrag}, waehrung = ${p.waehrung}, intervall = ${p.intervall},
      zahltag = ${p.zahltag}, beginn = ${p.beginn}, ende = ${p.ende ?? null},
      laufzeit_monate = ${p.laufzeit_monate ?? null},
      kuendigungsfrist_monate = ${p.kuendigungsfrist_monate}, notiz = ${p.notiz ?? null}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId, text: 'Vertrag geändert.' }
}

export async function vertragKuendigen(
  p: { zum?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ zum: string }[]>`
    select vertrag_kuendigen(${ctx.recordId!}, ${p.zum ?? null}, ${ctx.actor})::text as zum`
  return { recordId: ctx.recordId, text: `Gekündigt zum ${row.zum.slice(0, 10)}.` }
}

export async function vertragZahlen(
  p: { gezahlt_am?: string; bankkonto_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [vertrag] = await sql<{ betrag: number; waehrung: string }[]>`
    select betrag, waehrung from vertraege where id = ${ctx.recordId!}`
  if (!vertrag) throw new Error('Unbekannter Vertrag')
  await sql`
    select zahlung_erfassen(
      'aus', ${vertrag.betrag}, ${vertrag.waehrung},
      ${p.gezahlt_am ?? sql`current_date`}, ${p.bankkonto_id ?? null},
      'vertrag', ${ctx.recordId!}, null, ${ctx.actor})`
  return { recordId: ctx.recordId, text: 'Vertragszahlung erfasst.' }
}
