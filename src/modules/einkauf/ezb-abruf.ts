import { sql } from '@/db/client'
import { withTransaction } from '@/modules/integrationen/transaktionen'
import { EZB_URL, eurJeEinheit, ezbFakeXml, ezbXmlLesen } from './ezb.ts'

/**
 * EZB-Kurse abrufen und speichern (Job `ezb_kurse_abrufen`, Knopf auf der
 * Kurse-Seite): nur Währungen, die KRNL kennt; ein Kurs mit Quelle
 * `manuell` für denselben Tag bleibt stehen. EZB_FAKE=1 liefert feste
 * Kurse (Tests, Staging).
 */
export async function ezbKurseAbrufen(): Promise<string> {
  const heute = new Date().toISOString().slice(0, 10)
  const xml =
    process.env.EZB_FAKE === '1'
      ? ezbFakeXml(heute)
      : await withTransaction({ system: 'ezb', kind: 'kurse_abrufen', reference: 'eurofxref-daily' }, async () => {
          const antwort = await fetch(EZB_URL, { headers: { accept: 'application/xml' }, signal: AbortSignal.timeout(20_000) })
          if (!antwort.ok) throw new Error(`EZB antwortet ${antwort.status}`)
          return antwort.text()
        }, (text) => ({ laenge: text.length }))
  const { datum, kurse } = ezbXmlLesen(xml)

  const bekannt = await sql<{ code: string }[]>`select code from currencies where code <> 'EUR'`
  const uebernommen: string[] = []
  const manuell: string[] = []
  for (const { code } of bekannt) {
    const kurs = kurse[code]
    if (!kurs) continue
    const [r] = await sql<{ source: string | null }[]>`
      insert into exchange_rates (currency, rate, valid_from, source)
      values (${code}, ${eurJeEinheit(kurs)}, ${datum}::date, 'ezb')
      on conflict (currency, valid_from) do update
        set rate = excluded.rate, source = 'ezb'
        where exchange_rates.source is distinct from 'manuell'
      returning source`
    if (r) uebernommen.push(code)
    else manuell.push(code)
  }
  const teile = [`EZB-Kurse vom ${datum.split('-').reverse().join('.')}: ${uebernommen.join(', ') || 'keine'} übernommen`]
  if (manuell.length) teile.push(`${manuell.join(', ')} von Hand gepflegt — nicht überschrieben`)
  return teile.join('; ')
}
