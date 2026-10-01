import type { Sql, TransactionSql } from 'postgres'
import { sql, tx } from '@/db/client'
import { dokumenteListe, type PflichtModell } from '@/modules/einkauf/pflichtdokumente'
import { KOSTEN_ARTEN, type KostenArt, SENDUNG_STATUS, type SendungModus, type SendungStatus } from '@/modules/einkauf/sendungen'
import { entwurfAnlegen } from './einkauf-mailversand-ausfuehren.ts'
import { type AktionsErgebnis, type AktionsKontext, UUID_MUSTER } from './typen.ts'

/**
 * Ausführung Einkauf Stufe 5 (0108): Eingangssendungen, Kosten und Zoll,
 * Pflichtdokument-Nachfrage, gelernte Einstandssätze. Die Rechenarbeit
 * (Synchronisation auf die Bestellungen, Verteilung auf die Wareneingänge,
 * Abrechnung, Schätzung) liegt in SQL (eingangs_sendung_*), hier nur die
 * Prüfungen und Texte.
 */

type Db = Sql | TransactionSql

interface Sendung {
  id: string
  nummer: string
  status: SendungStatus
  modus: SendungModus
  spediteur_id: string | null
  hbl_awb: string | null
  verschifft_am: string | null
}

async function sendungLesen(id: string, db: Db = sql): Promise<Sendung> {
  const [s] = await db<Sendung[]>`
    select id, nummer, status::text as status, modus, spediteur_id, hbl_awb, verschifft_am::text as verschifft_am
    from eingangs_sendungen where id = ${id}`
  if (!s) throw new Error('Eingangssendung nicht gefunden.')
  return s
}

function nichtIn(s: Sendung, verboten: SendungStatus[], was: string) {
  if (verboten.includes(s.status)) throw new Error(`${s.nummer} ist ${SENDUNG_STATUS[s.status].toLowerCase()} — ${was} geht nicht mehr.`)
}

const geld = (betrag: number, waehrung: string) =>
  `${betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${waehrung}`

/** Bestellungen aus Nummern (P00042) oder IDs — nur bestätigte, sonst eine klare Meldung. */
async function bestellungenAufloesen(
  db: Db,
  eingaben: string[],
): Promise<{ id: string; number: string; vendor_id: string }[]> {
  const ergebnis: { id: string; number: string; vendor_id: string }[] = []
  const fehlend: string[] = []
  for (const roh of [...new Set(eingaben.map((e) => e.trim()).filter(Boolean))]) {
    const [po] = UUID_MUSTER.test(roh)
      ? await db<{ id: string; number: string; vendor_id: string; state: string }[]>`
          select id, number, vendor_id, state::text as state from purchase_orders where id = ${roh}`
      : await db<{ id: string; number: string; vendor_id: string; state: string }[]>`
          select id, number, vendor_id, state::text as state from purchase_orders where upper(number) = upper(${roh})`
    if (!po) {
      fehlend.push(roh)
      continue
    }
    if (po.state !== 'purchase' && po.state !== 'done') {
      throw new Error(`${po.number} ist ${po.state === 'cancel' ? 'storniert' : 'noch nicht bestätigt'} — in eine Sendung kommen bestätigte Bestellungen.`)
    }
    if (!ergebnis.some((e) => e.id === po.id)) ergebnis.push({ id: po.id, number: po.number, vendor_id: po.vendor_id })
  }
  if (fehlend.length) throw new Error(`Bestellung nicht gefunden: ${fehlend.join(', ')}`)
  return ergebnis
}

async function partnerPruefen(id: string | undefined, rolle: string) {
  if (!id) return
  const [p] = await sql<{ id: string }[]>`select id from partners where id = ${id}`
  if (!p) throw new Error(`${rolle} nicht gefunden.`)
}

async function waehrungPruefen(code: string) {
  const [w] = await sql<{ code: string }[]>`select code from currencies where code = ${code}`
  if (!w) throw new Error(`Währung ${code} ist in KRNL nicht angelegt.`)
}

/** Dokument prüfen und an die Sendung hängen (zählt dann für die Pflichtdokumente). */
async function dokumentAnSendung(db: Db, dokumentId: string | undefined, sendungId: string, actor: string) {
  if (!dokumentId) return
  const [d] = await db<{ id: string }[]>`select id from dokumente where id = ${dokumentId}`
  if (!d) throw new Error('Dokument nicht gefunden.')
  await db`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
           values (${dokumentId}, 'eingangs_sendung', ${sendungId}, ${actor})
           on conflict (dokument_id, modell, record_id) do nothing`
}

interface KopfFelder {
  bezeichnung?: string
  modus?: SendungModus
  spediteur_id?: string
  traeger?: string
  hbl_awb?: string
  container?: string
  tracking_url?: string
  etd?: string
  eta?: string
  gewicht_kg?: number
  volumen_cbm?: number
  packstuecke?: number
  zustaendig_id?: string
  notiz?: string
}

export async function sendungAnlegen(p: KopfFelder & { bestellungen: string[] }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await partnerPruefen(p.spediteur_id, 'Spediteur')
  const neu = await tx(async (t) => {
    const bestellungen = await bestellungenAufloesen(t, p.bestellungen)
    const [s] = await t<{ id: string; nummer: string }[]>`
      insert into eingangs_sendungen (nummer, bezeichnung, modus, spediteur_id, traeger, hbl_awb, container, tracking_url,
                                      etd, eta, gewicht_kg, volumen_cbm, packstuecke, zustaendig_id, notiz, erstellt_von)
      values (next_sequence('eingangs_sendung'), ${p.bezeichnung ?? null}, ${p.modus ?? 'see'}, ${p.spediteur_id ?? null},
              ${p.traeger ?? null}, ${p.hbl_awb ?? null}, ${p.container ?? null}, ${p.tracking_url ?? null},
              ${p.etd ?? null}, ${p.eta ?? null}, ${p.gewicht_kg ?? null}, ${p.volumen_cbm ?? null}, ${p.packstuecke ?? null},
              ${p.zustaendig_id ?? ctx.userId ?? null}, ${p.notiz ?? null}, ${ctx.actor})
      returning id, nummer`
    for (const b of bestellungen) {
      await t`insert into eingangs_sendung_bestellungen (sendung_id, purchase_order_id, hinzugefuegt_von)
              values (${s.id}, ${b.id}, ${ctx.actor})`
      await t`select log_event('purchase_order', ${b.id}, 'info', ${`In Eingangssendung ${s.nummer} aufgenommen`}, ${ctx.actor})`
    }
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    await t`select log_event('eingangs_sendung', ${s.id}, 'state',
                             ${`Angelegt${bestellungen.length ? ` mit ${bestellungen.map((b) => b.number).join(', ')}` : ''}`}, ${ctx.actor})`
    return { ...s, anzahl: bestellungen.length }
  })
  return {
    text: `Eingangssendung ${neu.nummer} angelegt${neu.anzahl ? ` mit ${neu.anzahl} Bestellung(en)` : ''}.`,
    recordId: neu.id,
    link: `/einkauf/sendungen/${neu.id}`,
  }
}

export async function sendungAendern(
  p: KopfFelder & { verschifft_am?: string; verzollt_am?: string; angekommen_am?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['storniert'], 'Bearbeiten')
  await partnerPruefen(p.spediteur_id, 'Spediteur')
  await tx(async (t) => {
    await t`
      update eingangs_sendungen set
        bezeichnung = coalesce(${p.bezeichnung ?? null}, bezeichnung),
        modus = coalesce(${p.modus ?? null}, modus),
        spediteur_id = coalesce(${p.spediteur_id ?? null}::uuid, spediteur_id),
        traeger = coalesce(${p.traeger ?? null}, traeger),
        hbl_awb = coalesce(${p.hbl_awb ?? null}, hbl_awb),
        container = coalesce(${p.container ?? null}, container),
        tracking_url = coalesce(${p.tracking_url ?? null}, tracking_url),
        etd = coalesce(${p.etd ?? null}::date, etd),
        eta = coalesce(${p.eta ?? null}::date, eta),
        gewicht_kg = coalesce(${p.gewicht_kg ?? null}, gewicht_kg),
        volumen_cbm = coalesce(${p.volumen_cbm ?? null}, volumen_cbm),
        packstuecke = coalesce(${p.packstuecke ?? null}, packstuecke),
        zustaendig_id = coalesce(${p.zustaendig_id ?? null}::uuid, zustaendig_id),
        notiz = coalesce(${p.notiz ?? null}, notiz),
        -- Tatsachen-Daten nur korrigieren, wenn der Zustand erreicht ist.
        verschifft_am = case when verschifft_am is not null then coalesce(${p.verschifft_am ?? null}::date, verschifft_am) else verschifft_am end,
        verzollt_am = case when verzollt_am is not null then coalesce(${p.verzollt_am ?? null}::date, verzollt_am) else verzollt_am end,
        angekommen_am = case when angekommen_am is not null then coalesce(${p.angekommen_am ?? null}::date, angekommen_am) else angekommen_am end
      where id = ${s.id}`
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    await t`select log_event('eingangs_sendung', ${s.id}, 'info', 'Daten der Sendung geändert', ${ctx.actor})`
  })
  return { text: `${s.nummer} gespeichert.`, recordId: s.id }
}

export async function sendungBestellungZuordnen(p: { bestellungen: string[] }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['abgerechnet', 'storniert'], 'Bestellungen aufnehmen')
  const ergebnis = await tx(async (t) => {
    const bestellungen = await bestellungenAufloesen(t, p.bestellungen)
    const neu: string[] = []
    for (const b of bestellungen) {
      const r = await t`insert into eingangs_sendung_bestellungen (sendung_id, purchase_order_id, hinzugefuegt_von)
                        values (${s.id}, ${b.id}, ${ctx.actor}) on conflict do nothing returning purchase_order_id`
      if (r.length) {
        neu.push(b.number)
        await t`select log_event('purchase_order', ${b.id}, 'info', ${`In Eingangssendung ${s.nummer} aufgenommen`}, ${ctx.actor})`
      }
    }
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    if (neu.length) await t`select log_event('eingangs_sendung', ${s.id}, 'info', ${`Aufgenommen: ${neu.join(', ')}`}, ${ctx.actor})`
    const [{ n }] = await t<{ n: number }[]>`select count(*)::int as n from stock_pickings where eingangs_sendung_id = ${s.id}`
    return { neu, eingaenge: Number(n) }
  })
  if (!ergebnis.neu.length) return { text: 'Die Bestellungen sind schon in der Sendung.', recordId: s.id }
  return {
    text: `${ergebnis.neu.join(', ')} in ${s.nummer} aufgenommen — ${ergebnis.eingaenge} Wareneingang/-eingänge hängen an der Sendung.`,
    recordId: s.id,
  }
}

export async function sendungBestellungLoesen(p: { purchase_order_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['abgerechnet', 'storniert'], 'Bestellungen herausnehmen')
  const [po] = await sql<{ number: string }[]>`
    select po.number from eingangs_sendung_bestellungen b join purchase_orders po on po.id = b.purchase_order_id
    where b.sendung_id = ${s.id} and b.purchase_order_id = ${p.purchase_order_id}`
  if (!po) throw new Error('Die Bestellung ist nicht in dieser Sendung.')
  const [gebucht] = await sql<{ number: string }[]>`
    select number from stock_pickings
    where eingangs_sendung_id = ${s.id} and origin_model = 'purchase_order' and origin_id = ${p.purchase_order_id} and state = 'done'
    limit 1`
  if (gebucht) throw new Error(`${gebucht.number} ist schon mit ${s.nummer} gebucht — die Bestellung bleibt in der Sendung.`)
  await tx(async (t) => {
    await t`update stock_pickings set eingangs_sendung_id = null
            where eingangs_sendung_id = ${s.id} and origin_model = 'purchase_order' and origin_id = ${p.purchase_order_id}`
    await t`delete from eingangs_sendung_bestellungen where sendung_id = ${s.id} and purchase_order_id = ${p.purchase_order_id}`
    await t`select log_event('eingangs_sendung', ${s.id}, 'info', ${`${po.number} herausgenommen`}, ${ctx.actor})`
    await t`select log_event('purchase_order', ${p.purchase_order_id}, 'info', ${`Aus Eingangssendung ${s.nummer} genommen`}, ${ctx.actor})`
  })
  return { text: `${po.number} aus ${s.nummer} genommen.`, recordId: s.id }
}

export async function sendungVerschiffen(
  p: { verschifft_am?: string; etd?: string; eta?: string; hbl_awb?: string; container?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  if (s.status !== 'geplant') throw new Error(`${s.nummer} ist schon ${SENDUNG_STATUS[s.status].toLowerCase()}.`)
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from eingangs_sendung_bestellungen where sendung_id = ${s.id}`
  if (Number(n) === 0) throw new Error(`${s.nummer} hat noch keine Bestellung — erst Bestellungen aufnehmen.`)

  const raten = await tx(async (t) => {
    await t`
      update eingangs_sendungen set
        status = 'verschifft',
        verschifft_am = coalesce(${p.verschifft_am ?? null}::date, current_date),
        etd = coalesce(${p.etd ?? null}::date, etd, coalesce(${p.verschifft_am ?? null}::date, current_date)),
        eta = coalesce(${p.eta ?? null}::date, eta),
        hbl_awb = coalesce(${p.hbl_awb ?? null}, hbl_awb),
        container = coalesce(${p.container ?? null}, container)
      where id = ${s.id}`
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    await t`select log_event('eingangs_sendung', ${s.id}, 'state', 'Verschifft', ${ctx.actor})`
    return t<{ number: string }[]>`
      select distinct po.number from zahlplan_raten r
      join eingangs_sendung_bestellungen b on b.purchase_order_id = r.purchase_order_id and b.sendung_id = ${s.id}
      join purchase_orders po on po.id = r.purchase_order_id
      where r.ausloeser = 'verschiffung' and r.bezahlt_am is null
      order by po.number`
  })
  return {
    text:
      `${s.nummer} verschifft.` +
      (raten.length ? ` Zahlplan-Raten „bei Verschiffung" von ${raten.map((r) => r.number).join(', ')} sind jetzt fällig.` : ''),
    recordId: s.id,
  }
}

export async function sendungVerzollen(p: { verzollt_am?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  if (s.status !== 'verschifft') throw new Error(`${s.nummer} ist ${SENDUNG_STATUS[s.status].toLowerCase()} — verzollt wird eine verschiffte Sendung.`)
  await sql`update eingangs_sendungen set status = 'verzollt', verzollt_am = coalesce(${p.verzollt_am ?? null}::date, current_date)
            where id = ${s.id}`
  await sql`select log_event('eingangs_sendung', ${s.id}, 'state', 'Verzollt', ${ctx.actor})`
  return { text: `${s.nummer} verzollt — den Zollbescheid unter „Zoll" erfassen.`, recordId: s.id }
}

export async function sendungAnkommen(p: { angekommen_am?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  if (s.status !== 'verschifft' && s.status !== 'verzollt') {
    throw new Error(`${s.nummer} ist ${SENDUNG_STATUS[s.status].toLowerCase()} — ankommen kann eine verschiffte oder verzollte Sendung.`)
  }
  const offen = await tx(async (t) => {
    await t`update eingangs_sendungen set status = 'angekommen', angekommen_am = coalesce(${p.angekommen_am ?? null}::date, current_date)
            where id = ${s.id}`
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    await t`select log_event('eingangs_sendung', ${s.id}, 'state', 'Angekommen', ${ctx.actor})`
    return t<{ number: string }[]>`
      select number from stock_pickings where eingangs_sendung_id = ${s.id} and state not in ('done', 'cancel') order by number`
  })
  return {
    text: `${s.nummer} angekommen.${offen.length ? ` Jetzt die Wareneingänge buchen: ${offen.map((o) => o.number).join(', ')}.` : ''}`,
    recordId: s.id,
  }
}

export async function sendungAbrechnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  const n = await tx(async (t) => {
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    const [r] = await t<{ n: number }[]>`select eingangs_sendung_abrechnen(${s.id}, ${ctx.actor}) as n`
    return Number(r.n)
  })
  return {
    text: `${s.nummer} abgerechnet${n ? ` — ${n} Landed-Cost-Beleg(e) auf die Wareneingänge gebucht` : ''}.`,
    recordId: s.id,
  }
}

export async function sendungStornieren(p: { grund: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  if (s.status !== 'geplant' && s.status !== 'verschifft') {
    throw new Error(`${s.nummer} ist ${SENDUNG_STATUS[s.status].toLowerCase()} — storniert wird nur eine geplante oder verschiffte Sendung.`)
  }
  const [gebucht] = await sql<{ number: string }[]>`
    select number from stock_pickings where eingangs_sendung_id = ${s.id} and state = 'done' limit 1`
  if (gebucht) throw new Error(`${gebucht.number} ist schon gebucht — eine angekommene Sendung wird nicht storniert.`)
  const [verteilt] = await sql<{ id: string }[]>`
    select l.id from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
    where k.sendung_id = ${s.id} and l.state = 'posted' limit 1`
  if (verteilt) throw new Error('Es sind schon Kosten verteilt — erst die Kostenpositionen stornieren.')
  await tx(async (t) => {
    await t`update stock_pickings set eingangs_sendung_id = null where eingangs_sendung_id = ${s.id}`
    await t`update eingangs_sendungen set status = 'storniert', storno_grund = ${p.grund} where id = ${s.id}`
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    await t`select log_event('eingangs_sendung', ${s.id}, 'state', ${`Storniert: ${p.grund}`}, ${ctx.actor})`
  })
  return { text: `${s.nummer} storniert.`, recordId: s.id }
}

export async function sendungKostenErfassen(
  p: {
    art: KostenArt
    betrag: number
    waehrung: string
    belegdatum?: string
    schaetzung: boolean
    partner_id?: string
    vendor_bill_id?: string
    dokument_id?: string
    notiz?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['storniert'], 'Kosten erfassen')
  if (p.schaetzung && s.status === 'abgerechnet') throw new Error(`${s.nummer} ist abgerechnet — dort gibt es nur noch echte Kosten.`)
  await waehrungPruefen(p.waehrung)
  await partnerPruefen(p.partner_id, 'Rechnungssteller')
  if (p.vendor_bill_id) {
    const [b] = await sql<{ id: string }[]>`select id from vendor_bills where id = ${p.vendor_bill_id} and state <> 'cancel'`
    if (!b) throw new Error('Lieferantenrechnung nicht gefunden oder storniert.')
  }

  const ersetzt = await tx(async (t) => {
    await dokumentAnSendung(t, p.dokument_id, s.id, ctx.actor)
    const [k] = await t<{ id: string }[]>`
      insert into sendung_kosten (sendung_id, art, betrag, waehrung, belegdatum, schaetzung, partner_id, vendor_bill_id,
                                  dokument_id, notiz, erstellt_von)
      values (${s.id}, ${p.art}, ${p.betrag}, ${p.waehrung}, ${p.belegdatum ?? null}, ${p.schaetzung}, ${p.partner_id ?? null},
              ${p.vendor_bill_id ?? null}, ${p.dokument_id ?? null}, ${p.notiz ?? null}, ${ctx.actor})
      returning id`
    // Die echte Rechnung ersetzt die offenen Schätzungen derselben Art.
    const alt = p.schaetzung
      ? []
      : await t<{ id: string }[]>`
          update sendung_kosten set ersetzt_durch_id = ${k.id}
          where sendung_id = ${s.id} and art = ${p.art} and schaetzung and storniert_am is null
            and ersetzt_durch_id is null and id <> ${k.id}
          returning id`
    await t`select log_event('eingangs_sendung', ${s.id}, 'info',
                             ${`${KOSTEN_ARTEN[p.art]} ${geld(p.betrag, p.waehrung)}${p.schaetzung ? ' (Schätzung)' : ''} erfasst${alt.length ? ' — ersetzt die Schätzung' : ''}`},
                             ${ctx.actor})`
    return alt.length
  })
  const hinweis =
    p.art === 'eust'
      ? ' Die EUSt wird nicht auf die Ware verteilt.'
      : ersetzt
        ? ' Ersetzt die Schätzung — beim Verteilen wird die Differenz korrigiert.'
        : ''
  return { text: `${KOSTEN_ARTEN[p.art]} ${geld(p.betrag, p.waehrung)} erfasst.${hinweis}`, recordId: s.id }
}

export async function sendungKostenEntfernen(p: { kosten_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  const [k] = await sql<{ id: string; art: KostenArt }[]>`
    select id, art from sendung_kosten where id = ${p.kosten_id} and sendung_id = ${s.id}`
  if (!k) throw new Error('Die Kostenposition gehört nicht zu dieser Sendung.')
  await sql`select sendung_kosten_stornieren(${k.id}, ${ctx.actor})`
  return { text: `${KOSTEN_ARTEN[k.art]} storniert.`, recordId: s.id }
}

export async function sendungVerteilen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['storniert'], 'Verteilen')
  const n = await tx(async (t) => {
    await t`select eingangs_sendung_synchronisieren(${s.id}, ${ctx.actor})`
    const [r] = await t<{ n: number }[]>`select eingangs_sendung_verteilen(${s.id}, ${ctx.actor}) as n`
    return Number(r.n)
  })
  return {
    text: n ? `${n} Landed-Cost-Beleg(e) auf die Wareneingänge von ${s.nummer} gebucht.` : 'Nichts zu verteilen — alle Kosten sind verteilt.',
    recordId: s.id,
  }
}

export async function sendungSchaetzen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['abgerechnet', 'storniert'], 'Schätzen')
  const angelegt = await tx(async (t) => {
    const vorschlag = await t<{ art: KostenArt; betrag: number; grundlage: string }[]>`
      select art, betrag::float as betrag, grundlage from eingangs_sendung_schaetzung(${s.id})`
    const neu: string[] = []
    for (const v of vorschlag) {
      const [da] = await t`select 1 from sendung_kosten
                           where sendung_id = ${s.id} and art = ${v.art} and storniert_am is null and ersetzt_durch_id is null`
      if (da) continue
      await t`insert into sendung_kosten (sendung_id, art, betrag, waehrung, schaetzung, notiz, erstellt_von)
              values (${s.id}, ${v.art}, ${v.betrag}, 'EUR', true, ${v.grundlage}, ${ctx.actor})`
      neu.push(`${KOSTEN_ARTEN[v.art]} ${geld(v.betrag, 'EUR')}`)
    }
    if (neu.length) await t`select log_event('eingangs_sendung', ${s.id}, 'info', ${`Geschätzt: ${neu.join(', ')}`}, ${ctx.actor})`
    return { neu, vorschlaege: vorschlag.length }
  })
  if (!angelegt.vorschlaege) {
    return { text: 'Keine Schätzung möglich — es fehlen Gewichte (Sendung oder Artikel) bzw. Zollsätze für die HS-Codes.', recordId: s.id }
  }
  return {
    text: angelegt.neu.length ? `Geschätzt: ${angelegt.neu.join(', ')}.` : 'Für Fracht und Zoll gibt es schon Kostenpositionen — nichts geschätzt.',
    recordId: s.id,
  }
}

export async function sendungZollErfassen(
  p: {
    zeilen: {
      hs_code: string
      zollwert_eur: number
      zoll_eur: number
      eust_eur: number
      purchase_order_id?: string
      ursprungsland?: string
    }[]
    belegdatum?: string
    partner_id?: string
    dokument_id?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const s = await sendungLesen(ctx.recordId!)
  nichtIn(s, ['geplant', 'storniert'], 'den Zollbescheid erfassen')
  await partnerPruefen(p.partner_id ?? s.spediteur_id ?? undefined, 'Rechnungssteller')
  const zoll = Math.round(p.zeilen.reduce((a, z) => a + z.zoll_eur, 0) * 100) / 100
  const eust = Math.round(p.zeilen.reduce((a, z) => a + z.eust_eur, 0) * 100) / 100

  await tx(async (t) => {
    for (const z of p.zeilen) {
      if (!z.purchase_order_id) continue
      const [b] = await t`select 1 from eingangs_sendung_bestellungen where sendung_id = ${s.id} and purchase_order_id = ${z.purchase_order_id}`
      if (!b) throw new Error('Eine Zollzeile nennt eine Bestellung, die nicht in der Sendung ist.')
    }
    await dokumentAnSendung(t, p.dokument_id, s.id, ctx.actor)
    // Ein neuer Bescheid ersetzt den alten: Zeilen neu, alte Bescheid-Kosten storniert (samt Landed Costs).
    await t`delete from sendung_zoll where sendung_id = ${s.id}`
    for (const z of p.zeilen) {
      await t`insert into sendung_zoll (sendung_id, purchase_order_id, hs_code, ursprungsland, zollwert_eur, zoll_eur, eust_eur)
              values (${s.id}, ${z.purchase_order_id ?? null}, ${z.hs_code}, ${z.ursprungsland?.toUpperCase() ?? null},
                      ${z.zollwert_eur}, ${z.zoll_eur}, ${z.eust_eur})`
    }
    const alt = await t<{ id: string }[]>`
      select id from sendung_kosten where sendung_id = ${s.id} and aus_zollbescheid and storniert_am is null`
    for (const a of alt) await t`select sendung_kosten_stornieren(${a.id}, ${ctx.actor})`

    for (const [art, betrag] of [['zoll', zoll], ['eust', eust]] as const) {
      const [schaetzung] = await t`select 1 from sendung_kosten where sendung_id = ${s.id} and art = ${art} and schaetzung
                                   and storniert_am is null and ersetzt_durch_id is null`
      // Auch 0 € (zollfreie Ware) wird erfasst, wenn eine Schätzung abzulösen ist.
      if (betrag <= 0 && !schaetzung) continue
      const [k] = await t<{ id: string }[]>`
        insert into sendung_kosten (sendung_id, art, betrag, waehrung, belegdatum, schaetzung, aus_zollbescheid, partner_id,
                                    dokument_id, notiz, erstellt_von)
        values (${s.id}, ${art}, ${betrag}, 'EUR', ${p.belegdatum ?? null}, false, true, ${p.partner_id ?? s.spediteur_id ?? null},
                ${p.dokument_id ?? null}, 'aus dem Zollbescheid', ${ctx.actor})
        returning id`
      await t`update sendung_kosten set ersetzt_durch_id = ${k.id}
              where sendung_id = ${s.id} and art = ${art} and schaetzung and storniert_am is null
                and ersetzt_durch_id is null and id <> ${k.id}`
    }
    await t`select log_event('eingangs_sendung', ${s.id}, 'info',
                             ${`Zollbescheid erfasst: ${p.zeilen.length} Zeile(n), Zoll ${geld(zoll, 'EUR')}, EUSt ${geld(eust, 'EUR')}`},
                             ${ctx.actor})`
  })
  return {
    text: `Zollbescheid erfasst: Zoll ${geld(zoll, 'EUR')}, EUSt ${geld(eust, 'EUR')} (die EUSt wird nicht auf die Ware verteilt).`,
    recordId: s.id,
  }
}

export async function pflichtdokumenteNachfragen(
  p: { modell: PflichtModell; record_id: string; antwort_erwartet_bis?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const fehlend = await sql<{ art: string; nummer: string }[]>`
    select art, nummer from einkauf_offene_pflichtdokumente
    where modell = ${p.modell} and record_id = ${p.record_id}
    order by art`
  if (!fehlend.length) {
    const [beleg] =
      p.modell === 'purchase_order'
        ? await sql<{ nummer: string }[]>`select number as nummer from purchase_orders where id = ${p.record_id}`
        : await sql<{ nummer: string }[]>`select nummer from eingangs_sendungen where id = ${p.record_id}`
    if (!beleg) throw new Error(p.modell === 'purchase_order' ? 'Bestellung nicht gefunden.' : 'Eingangssendung nicht gefunden.')
    throw new Error(`Für ${beleg.nummer} fehlt derzeit kein Pflichtdokument.`)
  }
  const arten = fehlend.map((f) => f.art)
  const nummer = fehlend[0].nummer

  let ergebnis: AktionsErgebnis
  if (p.modell === 'purchase_order') {
    ergebnis = await entwurfAnlegen(
      {
        purchase_order_id: p.record_id,
        vorlage: 'dokumente_nachfragen',
        anhang_dokument_ids: [],
        bestell_pdf: false,
        antwort_erwartet_bis: p.antwort_erwartet_bis,
      },
      ctx,
      'mensch',
      { werte: (sprache) => ({ dokumente: dokumenteListe(arten, 'purchase_order', sprache) }) },
    )
  } else {
    const s = await sendungLesen(p.record_id)
    if (!s.spediteur_id) throw new Error(`An ${s.nummer} ist kein Spediteur eingetragen — erst den Spediteur hinterlegen.`)
    const bezug = `${s.nummer}${s.hbl_awb ? ` (HBL/AWB ${s.hbl_awb})` : ''}`
    ergebnis = await entwurfAnlegen(
      {
        partner_id: s.spediteur_id,
        vorlage: 'dokumente_nachfragen',
        anhang_dokument_ids: [],
        bestell_pdf: false,
        antwort_erwartet_bis: p.antwort_erwartet_bis,
      },
      ctx,
      'mensch',
      { werte: (sprache) => ({ bestellnummer: bezug, dokumente: dokumenteListe(arten, 'eingangs_sendung', sprache) }) },
    )
  }
  await sql`select log_event(${p.modell}, ${p.record_id}, 'info',
                             ${`Fehlende Dokumente nachgefragt (Entwurf): ${dokumenteListe(arten, p.modell, 'de').replace(/- /g, '').split('\n').join(', ')}`},
                             ${ctx.actor})`
  return { ...ergebnis, text: `Entwurf „Fehlende Dokumente" zu ${nummer} angelegt — gegenlesen und freigeben.` }
}

export async function einstandVorschlagUebernehmen(
  p: { art: 'fracht' | 'zoll'; schluessel: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [v] = await sql<{ ist_wert: number; grundlage: string }[]>`
    select ist_wert::float as ist_wert, grundlage from einkauf_einstand_vorschlaege
    where art = ${p.art} and schluessel = ${p.schluessel}`
  if (!v) throw new Error('Dazu gibt es keinen Vorschlag (mehr) — die Sätze passen schon zu den abgerechneten Sendungen.')
  const notiz = `Gelernt aus Sendungen (${new Date().toISOString().slice(0, 10)}): ${v.grundlage}`
  if (p.art === 'fracht') {
    if (!(v.ist_wert > 0)) throw new Error('Der gelernte Frachtsatz ist 0 — nicht übernommen.')
    await sql`
      insert into frachtsaetze (modus, eur_je_kg, mindestbetrag_eur, notiz, geaendert_von)
      values (${p.schluessel}, ${v.ist_wert}, 0, ${notiz}, ${ctx.actor})
      on conflict (modus) do update set eur_je_kg = excluded.eur_je_kg, notiz = excluded.notiz, geaendert_von = excluded.geaendert_von`
    return { text: `Frachtsatz ${p.schluessel}: ${v.ist_wert.toLocaleString('de-DE')} €/kg übernommen.` }
  }
  await sql`
    insert into zolltarife (hs_praefix, satz_pct, bezeichnung, geaendert_von)
    values (${p.schluessel}, ${v.ist_wert}, ${notiz.slice(0, 200)}, ${ctx.actor})
    on conflict (hs_praefix) do update set satz_pct = excluded.satz_pct, geaendert_von = excluded.geaendert_von`
  return { text: `Zollsatz ${p.schluessel}: ${v.ist_wert.toLocaleString('de-DE')} % übernommen.` }
}
