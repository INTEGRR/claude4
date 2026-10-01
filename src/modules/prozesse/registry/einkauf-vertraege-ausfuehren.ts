import { sql, tx } from '@/db/client'
import {
  MIT_PREISEN,
  type PreislistenZeile,
  VERTRAG_ARTEN,
  type VertragArt,
  type VertragStatus,
  VERTRAG_STATUS,
  preislisteLesen,
} from '@/modules/einkauf/lieferantenvertraege'
import { varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 4 (0107): Lieferantenverträge und Preislisten (prozessfrei). */

interface Vertrag {
  id: string
  partner_id: string
  lieferant: string
  art: VertragArt
  titel: string
  gueltig_von: string | null
  gueltig_bis: string | null
  waehrung: string
  status: VertragStatus
}

async function vertragLesen(id: string): Promise<Vertrag> {
  const [v] = await sql<Vertrag[]>`
    select v.id, v.partner_id, p.name as lieferant, v.art::text as art, v.titel, v.gueltig_von::text as gueltig_von,
           v.gueltig_bis::text as gueltig_bis, v.waehrung, v.status::text as status
    from lieferantenvertraege v join partners p on p.id = v.partner_id
    where v.id = ${id}`
  if (!v) throw new Error('Lieferantenvertrag nicht gefunden.')
  return v
}

async function waehrungPruefen(code: string) {
  const [w] = await sql`select 1 from currencies where code = ${code}`
  if (!w) throw new Error(`Währung ${code} ist in KRNL nicht angelegt.`)
}

const deutsch = (iso: string | null) => (iso ? iso.split('-').reverse().join('.') : 'offen')

export async function vertragAnlegen(
  p: {
    partner_id: string
    art: VertragArt
    titel: string
    gueltig_von?: string
    gueltig_bis?: string
    kuendigungsfrist_monate: number
    verlaengerung_monate?: number
    erinnerung_tage: number
    waehrung?: string
    notiz?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [l] = await sql<{ name: string; standard_waehrung: string | null }[]>`
    select name, standard_waehrung from partners where id = ${p.partner_id}`
  if (!l) throw new Error('Lieferant nicht gefunden.')
  const waehrung = p.waehrung ?? l.standard_waehrung ?? 'EUR'
  await waehrungPruefen(waehrung)
  const v = await tx(async (t) => {
    const [neu] = await t<{ id: string }[]>`
      insert into lieferantenvertraege (partner_id, art, titel, gueltig_von, gueltig_bis, kuendigungsfrist_monate,
                                        verlaengerung_monate, erinnerung_tage, waehrung, notiz, erstellt_von)
      values (${p.partner_id}, ${p.art}::lieferantenvertrag_art, ${p.titel}, ${p.gueltig_von ?? null}, ${p.gueltig_bis ?? null},
              ${p.kuendigungsfrist_monate}, ${p.verlaengerung_monate ?? null}, ${p.erinnerung_tage}, ${waehrung},
              ${p.notiz ?? null}, ${ctx.actor})
      returning id`
    await t`select log_event('lieferantenvertrag', ${neu.id}, 'state',
                             ${`${VERTRAG_ARTEN[p.art]} angelegt (gültig ${deutsch(p.gueltig_von ?? null)} bis ${deutsch(p.gueltig_bis ?? null)})`},
                             ${ctx.actor})`
    await t`select log_event('partner', ${p.partner_id}, 'info', ${`Vertrag „${p.titel}" (${VERTRAG_ARTEN[p.art]}) angelegt`}, ${ctx.actor})`
    return neu
  })
  return {
    text: `${VERTRAG_ARTEN[p.art]} „${p.titel}" mit ${l.name} angelegt — Vertragsdatei als Dokument anhängen.`,
    recordId: v.id,
    link: `/einkauf/vertraege/${v.id}`,
  }
}

export async function vertragAendern(
  p: {
    titel?: string
    art?: VertragArt
    gueltig_von?: string
    gueltig_bis?: string
    kuendigungsfrist_monate?: number
    verlaengerung_monate?: number | ''
    erinnerung_tage?: number
    waehrung?: string
    notiz?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const v = await vertragLesen(ctx.recordId!)
  if (p.waehrung && p.waehrung !== v.waehrung) {
    await waehrungPruefen(p.waehrung)
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from vendor_prices where vertrag_id = ${v.id}`
    if (n > 0) {
      throw new Error(`Aus dem Vertrag stammen schon ${n} Preise in ${v.waehrung} — die Preisliste in der neuen Währung neu übernehmen statt umzustellen.`)
    }
  }
  await tx(async (t) => {
    const [neu] = await t<{ gueltig_von: string | null; gueltig_bis: string | null }[]>`
      update lieferantenvertraege set
        titel = coalesce(${p.titel ?? null}, titel),
        art = coalesce(${p.art ?? null}::lieferantenvertrag_art, art),
        gueltig_von = case when ${p.gueltig_von !== undefined} then nullif(${p.gueltig_von ?? ''}, '')::date else gueltig_von end,
        gueltig_bis = case when ${p.gueltig_bis !== undefined} then nullif(${p.gueltig_bis ?? ''}, '')::date else gueltig_bis end,
        kuendigungsfrist_monate = coalesce(${p.kuendigungsfrist_monate ?? null}, kuendigungsfrist_monate),
        verlaengerung_monate = case when ${p.verlaengerung_monate !== undefined}
                                    then nullif(${String(p.verlaengerung_monate ?? '')}, '')::int else verlaengerung_monate end,
        erinnerung_tage = coalesce(${p.erinnerung_tage ?? null}, erinnerung_tage),
        waehrung = coalesce(${p.waehrung ?? null}, waehrung),
        notiz = case when ${p.notiz !== undefined} then nullif(${p.notiz ?? ''}, '') else notiz end
      where id = ${v.id}
      returning gueltig_von::text as gueltig_von, gueltig_bis::text as gueltig_bis`
    // Lieferantenpreise aus dem Vertrag gelten, solange der Vertrag gilt.
    await t`update vendor_prices set date_start = ${neu.gueltig_von}, date_end = ${neu.gueltig_bis} where vertrag_id = ${v.id}`
    await t`select log_event('lieferantenvertrag', ${v.id}, 'info',
                             ${`Vertrag geändert (gültig ${deutsch(neu.gueltig_von)} bis ${deutsch(neu.gueltig_bis)})`}, ${ctx.actor})`
  })
  return { text: `„${p.titel ?? v.titel}" gespeichert.`, recordId: v.id }
}

export async function vertragStatusSetzen(
  p: { status: VertragStatus; datum?: string; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const v = await vertragLesen(ctx.recordId!)
  if (v.status === p.status) throw new Error(`„${v.titel}" ist schon ${VERTRAG_STATUS[p.status].toLowerCase()}.`)
  if (p.status === 'gekuendigt' && v.status !== 'aktiv') throw new Error('Gekündigt werden kann nur ein aktiver Vertrag.')
  const notiz = p.notiz ? ` — ${p.notiz}` : ''

  await tx(async (t) => {
    if (p.status === 'gekuendigt') {
      await t`update lieferantenvertraege set status = 'gekuendigt', gekuendigt_am = coalesce(${p.datum ?? null}::date, current_date)
              where id = ${v.id}`
      await t`select log_event('lieferantenvertrag', ${v.id}, 'state',
                               ${`Gekündigt am ${p.datum ? deutsch(p.datum) : 'heute'}${v.gueltig_bis ? ` zum ${deutsch(v.gueltig_bis)}` : ''}${notiz}`},
                               ${ctx.actor})`
    } else if (p.status === 'beendet') {
      // Endet zum Datum (frühestens): das Laufzeitende rückt vor, die Preise aus dem Vertrag enden mit.
      const [neu] = await t<{ gueltig_bis: string }[]>`
        update lieferantenvertraege set status = 'beendet',
          gueltig_bis = least(coalesce(gueltig_bis, coalesce(${p.datum ?? null}::date, current_date)),
                              coalesce(${p.datum ?? null}::date, current_date))
        where id = ${v.id}
        returning gueltig_bis::text as gueltig_bis`
      await t`update vendor_prices set date_end = least(coalesce(date_end, ${neu.gueltig_bis}::date), ${neu.gueltig_bis}::date)
              where vertrag_id = ${v.id}`
      await t`select log_event('lieferantenvertrag', ${v.id}, 'state', ${`Beendet zum ${deutsch(neu.gueltig_bis)}${notiz}`}, ${ctx.actor})`
    } else {
      await t`update lieferantenvertraege set status = 'aktiv', gekuendigt_am = null where id = ${v.id}`
      await t`select log_event('lieferantenvertrag', ${v.id}, 'state', ${`Wieder aktiv${notiz}`}, ${ctx.actor})`
    }
  })
  return { text: `„${v.titel}": ${VERTRAG_STATUS[p.status]}.`, recordId: v.id }
}

export async function preislisteUebernehmen(
  p: { text?: string; preise: PreislistenZeile[]; lieferzeit_tage?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const v = await vertragLesen(ctx.recordId!)
  if (!MIT_PREISEN.includes(v.art)) {
    throw new Error(`Preise entstehen aus einer Preisliste oder einem Rahmenvertrag — nicht aus „${VERTRAG_ARTEN[v.art]}".`)
  }
  if (v.status === 'beendet') throw new Error(`„${v.titel}" ist beendet — keine neuen Preise daraus.`)

  const gelesen = preislisteLesen(p.text ?? '')
  if (gelesen.fehler.length) throw new Error(`Nichts übernommen — bitte korrigieren: ${gelesen.fehler.join(' · ')}`)
  const zeilen = [...gelesen.zeilen, ...p.preise]
  if (zeilen.length === 0) throw new Error('Keine Preiszeile gefunden.')

  // Erst alle Artikel auflösen — ein unbekannter verhindert die ganze Übernahme.
  const aufgeloest: (PreislistenZeile & { variant_id: string })[] = []
  const unbekannt: string[] = []
  for (const z of zeilen) {
    try {
      aufgeloest.push({ ...z, variant_id: (await varianteAufloesen(sql, z.produkt)).id })
    } catch (err) {
      unbekannt.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (unbekannt.length) throw new Error(`Nichts übernommen — ${unbekannt.join(' · ')}.`)

  const anzahl = await tx(async (t) => {
    await t`delete from vendor_prices where vertrag_id = ${v.id}`
    for (const z of aufgeloest) {
      await t`
        insert into vendor_prices (vendor_id, template_id, variant_id, min_qty, price, currency, lead_time_days,
                                   date_start, date_end, vertrag_id)
        select ${v.partner_id}, pv.template_id, pv.id, ${z.ab_menge}, ${z.preis}, ${v.waehrung}, ${p.lieferzeit_tage ?? 0},
               ${v.gueltig_von}, ${v.gueltig_bis}, ${v.id}
        from product_variants pv where pv.id = ${z.variant_id}`
    }
    await t`select log_event('lieferantenvertrag', ${v.id}, 'info',
                             ${`Preisliste übernommen: ${aufgeloest.length} Lieferantenpreis(e) in ${v.waehrung}`}, ${ctx.actor})`
    return aufgeloest.length
  })
  return {
    text: `${anzahl} Lieferantenpreis(e) aus „${v.titel}" übernommen (${v.waehrung}, gültig ${deutsch(v.gueltig_von)} bis ${deutsch(v.gueltig_bis)}).`,
    recordId: v.id,
  }
}
