import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { LineBandChart } from '@/components/charts'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

interface PrognoseZeile {
  periode_start: string
  periode_ende: string
  anfangssaldo: number
  einzahlungen: number
  aus_bestellungen: number
  aus_vertraegen: number
  aus_darlehen: number
  aus_steuern: number
  aus_variable_quote: number
  auszahlungen: number
  endsaldo: number
}

/**
 * Finanzen-Cockpit: Kassenstand, Cashflow-Prognose (13 Wochen / 12 Monate,
 * Szenario-Band Best/Base/Worst), Fremdkapitalbedarf, fällige Zahlungen und
 * das Register. Die Prognose rechnet finanz_prognose() in der Datenbank —
 * hier wird nur gezeichnet.
 */
export default async function FinanzenSeite({
  searchParams,
}: {
  searchParams: Promise<{ raster?: string }>
}) {
  await requireArea('finanzen')
  const { raster: rasterParam } = await searchParams
  const raster = rasterParam === 'woche' ? 'woche' : 'monat'

  const salden = await sql<
    { bankkonto_id: string | null; name: string; saldo: number; stichtag: string | null }[]
  >`select * from finanz_saldo()`
  const gesamt = salden.reduce((s, k) => s + Number(k.saldo), 0)

  // Drei Szenarien für das Band; die Perioden sind in allen drei identisch.
  const [base, best, worst] = await Promise.all([
    sql<PrognoseZeile[]>`select * from finanz_prognose('base', ${raster})`,
    sql<PrognoseZeile[]>`select endsaldo from finanz_prognose('best', ${raster})`,
    sql<PrognoseZeile[]>`select endsaldo from finanz_prognose('worst', ${raster})`,
  ])
  const [bedarf] = await sql<
    { min_saldo: number; min_periode: string; fremdkapitalbedarf: number }[]
  >`select * from finanz_unterdeckung('base')`
  const planGefuellt = await sql<{ n: number }[]>`
    select count(*)::int as n from umsatzplan where monat >= date_trunc('month', current_date)`

  const kategorien = base.map((z) =>
    raster === 'woche'
      ? new Date(z.periode_start).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
      : new Date(z.periode_start).toLocaleDateString('de-DE', { month: 'short' }),
  )

  const faellig = await sql<
    { quelle: string; ref: string; label: string; partner: string | null;
      faellig_am: string; betrag_eur: number; richtung: string; link: string }[]
  >`select * from finanz_faellig(current_date + 14)`
  const faelligSumme = faellig.reduce((s, f) => s + Number(f.betrag_eur), 0)
  const ueberfaellig = faellig.filter((f) => new Date(f.faellig_am) < new Date())

  const zahlungen = await sql<
    { id: string; nummer: string; richtung: string; betrag_eur: number; gezahlt_am: string;
      quelle: string; verwendungszweck: string | null; partner: string | null;
      konto: string | null; storniert: boolean }[]
  >`
    select z.id, z.nummer, z.richtung, z.betrag_eur, z.gezahlt_am, z.quelle,
           z.verwendungszweck, p.name as partner, k.name as konto,
           (z.storniert_am is not null) as storniert
    from zahlungen z
    left join partners p on p.id = z.partner_id
    left join bankkonten k on k.id = z.bankkonto_id
    order by z.gezahlt_am desc, z.created_at desc
    limit 15`

  const bedarfBetrag = Number(bedarf?.fremdkapitalbedarf ?? 0)

  return (
    <>
      <PageHeader
        title="Finanzen"
        subtitle="Kassenstand, Cashflow-Prognose, fällige Zahlungen, Register"
        actions={
          <>
            <Link className="btn small" href="/finanzen/plan">
              Umsatzplan
            </Link>
            <Link className="btn small" href="/aktion/finanzen.bankkonto_anlegen">
              Bankkonto anlegen
            </Link>
            <Link className="btn small" href="/aktion/finanzen.kontostand_erfassen">
              Kontostand erfassen
            </Link>
            <Link className="btn small" href="/aktion/finanzen.zahlung_erfassen">
              Zahlung erfassen
            </Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Kassenstand gesamt" value={money(gesamt)} />
        {/* Die Zahl, für die dieses Modul gebaut wurde: was fehlt im
            schlechtesten Monat der 12-Monats-Prognose? Violett = hier wird
            entschieden (Fremdkapital aufnehmen oder Einkauf strecken). */}
        <Stat
          label="Fremdkapitalbedarf (12 Monate)"
          value={
            bedarfBetrag > 0 ? (
              <span style={{ color: 'var(--wichtig)' }}>{money(bedarfBetrag)}</span>
            ) : (
              money(0)
            )
          }
          hint={
            bedarfBetrag > 0
              ? `Tiefpunkt ${date(bedarf.min_periode)}: ${money(bedarf.min_saldo)}`
              : 'Prognose bleibt über dem Puffer'
          }
        />
        <Stat
          label="Fällig in 14 Tagen"
          value={money(faelligSumme)}
          hint={`${faellig.length} Posten`}
        />
        <Stat
          label="Überfällig"
          value={money(ueberfaellig.reduce((s, f) => s + Number(f.betrag_eur), 0))}
          hint={ueberfaellig.length > 0 ? `${ueberfaellig.length} Posten` : 'nichts'}
        />
      </div>

      <Card
        title={`Cashflow-Prognose (${raster === 'woche' ? '13 Wochen' : '12 Monate'})`}
        actions={
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <Link
              className={`btn small${raster === 'woche' ? ' primary' : ''}`}
              href="/finanzen?raster=woche"
            >
              13 Wochen
            </Link>
            <Link
              className={`btn small${raster === 'monat' ? ' primary' : ''}`}
              href="/finanzen"
            >
              12 Monate
            </Link>
          </span>
        }
      >
        {Number(planGefuellt[0]?.n ?? 0) === 0 ? (
          <Empty>
            Noch kein Umsatzplan — unter <Link href="/finanzen/plan">Umsatzplan</Link> die
            Vorschläge übernehmen, dann rechnet die Prognose mit Einnahmen statt nur mit
            den bekannten Auszahlungen.
          </Empty>
        ) : (
          <LineBandChart
            categories={kategorien}
            base={base.map((z) => Number(z.endsaldo))}
            best={best.map((z) => Number(z.endsaldo))}
            worst={worst.map((z) => Number(z.endsaldo))}
            unit="€"
          />
        )}
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Periode</th>
                <th style={{ textAlign: 'right' }}>Einzahlungen</th>
                <th style={{ textAlign: 'right' }}>Bestellungen</th>
                <th style={{ textAlign: 'right' }}>Verträge</th>
                <th style={{ textAlign: 'right' }}>Darlehen</th>
                <th style={{ textAlign: 'right' }}>Steuern</th>
                <th style={{ textAlign: 'right' }}>Variable (Quote)</th>
                <th style={{ textAlign: 'right' }}>Endsaldo</th>
              </tr>
            </thead>
            <tbody>
              {base.map((z) => (
                <tr key={z.periode_start}>
                  <td className="mono muted">
                    {date(z.periode_start)} – {date(z.periode_ende)}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.einzahlungen)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.aus_bestellungen)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.aus_vertraegen)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.aus_darlehen)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.aus_steuern)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(z.aus_variable_quote)}</td>
                  <td
                    className="mono"
                    style={{
                      textAlign: 'right',
                      color: Number(z.endsaldo) < 0 ? 'var(--danger)' : undefined,
                      fontWeight: Number(z.endsaldo) < 0 ? 600 : undefined,
                    }}
                  >
                    {money(z.endsaldo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <div className="grid-2">
        <Card title="Bankkonten">
          {salden.length === 0 ? (
            <Empty>
              Noch kein Bankkonto — mit „Bankkonto anlegen" starten, dann den Kontostand
              als Anker erfassen.
            </Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Konto</th>
                    <th>Anker (Stichtag)</th>
                    <th style={{ textAlign: 'right' }}>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {salden.map((k) => (
                    <tr key={k.bankkonto_id ?? 'ohne'}>
                      <td>{k.name}</td>
                      <td className="muted">{k.stichtag ? date(k.stichtag) : '—'}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(k.saldo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Fällig (14 Tage)">
          {faellig.length === 0 ? (
            <Empty>Keine fälligen Zahlungen in den nächsten zwei Wochen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Posten</th>
                    <th>Partner</th>
                    <th>Fällig</th>
                    <th style={{ textAlign: 'right' }}>Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {faellig.map((f) => (
                    <tr key={`${f.quelle}-${f.ref}`}>
                      <td><Link href={f.link}>{f.label}</Link></td>
                      <td className="muted">{f.partner ?? '—'}</td>
                      <td className={new Date(f.faellig_am) < new Date() ? 'mono' : 'mono muted'}>
                        {new Date(f.faellig_am) < new Date() && <span className="led warn" style={{ marginRight: 6 }} />}
                        {date(f.faellig_am)}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(f.betrag_eur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Zahlungsregister (letzte 15)">
        {zahlungen.length === 0 ? (
          <Empty>Noch keine Zahlungen erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Datum</th>
                  <th>Richtung</th>
                  <th>Quelle</th>
                  <th>Partner</th>
                  <th>Konto</th>
                  <th>Zweck</th>
                  <th style={{ textAlign: 'right' }}>Betrag</th>
                </tr>
              </thead>
              <tbody>
                {zahlungen.map((z) => (
                  <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                    <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                    <td className="mono muted">{date(z.gezahlt_am)}</td>
                    <td>{z.richtung === 'ein' ? 'Eingang' : 'Ausgang'}</td>
                    <td className="muted">{z.quelle}</td>
                    <td className="muted">{z.partner ?? '—'}</td>
                    <td className="muted">{z.konto ?? '—'}</td>
                    <td className="muted">{z.verwendungszweck ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {z.richtung === 'ein' ? '+' : '−'}{money(z.betrag_eur)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
