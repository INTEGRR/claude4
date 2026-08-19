import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { ColumnChart } from '@/components/charts'

export const dynamic = 'force-dynamic'

/**
 * Nutzungsbericht light (Entscheidung 2026-08: Reporting statt Lizenzmodul):
 * die drei Kerngrößen je Monat als Grundlage für Preisgespräche mit
 * Pilotkunden. Die Zahlen kommen aus nutzungsbericht() (Migration 0063)
 * und BLEIBEN in dieser Instanz — kein Phone-Home, gezogen wird von Hand.
 */
export default async function NutzungPage({
  searchParams,
}: {
  searchParams: Promise<{ monate?: string }>
}) {
  await requireArea('einstellungen')
  await requireAdmin()

  const params = await searchParams
  const monate = params.monate === '12' ? 12 : 6

  const zeilen = await sql<
    {
      monat: string
      aktive_nutzer: number
      belege: number
      ki_fragen: number
      sprachsitzungen: number
    }[]
  >`select to_char(monat, 'YYYY-MM') as monat, aktive_nutzer, belege, ki_fragen, sprachsitzungen
    from nutzungsbericht(${monate})`

  const kategorien = zeilen.map((z) => z.monat)

  return (
    <>
      <PageHeader
        title="Nutzung"
        subtitle="Aktive Nutzer, Belege und KI-Nutzung je Monat — die Grundlage für Preisgespräche."
        actions={
          <>
            <Link className={`btn ${monate === 6 ? 'primary' : ''}`} href="/einstellungen/nutzung">
              6 Monate
            </Link>
            <Link
              className={`btn ${monate === 12 ? 'primary' : ''}`}
              href="/einstellungen/nutzung?monate=12"
            >
              12 Monate
            </Link>
          </>
        }
      />

      <Card title="Verlauf" tight>
        <div style={{ padding: '12px 12px 0' }}>
          <ColumnChart
            categories={kategorien}
            series={[
              { name: 'Belege', values: zeilen.map((z) => z.belege) },
              { name: 'KI-Fragen', values: zeilen.map((z) => z.ki_fragen) },
              { name: 'Sprachsitzungen', values: zeilen.map((z) => z.sprachsitzungen) },
            ]}
          />
        </div>
      </Card>

      <Card title="Monatswerte" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Monat</th>
                <th className="num">Aktive Nutzer</th>
                <th className="num">Belege</th>
                <th className="num">KI-Fragen</th>
                <th className="num">Sprachsitzungen</th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => (
                <tr key={z.monat}>
                  <td className="mono">{z.monat}</td>
                  <td className="num">{z.aktive_nutzer}</td>
                  <td className="num">{z.belege}</td>
                  <td className="num">{z.ki_fragen}</td>
                  <td className="num">{z.sprachsitzungen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <p className="muted small">
        Aktive Nutzer = Konten mit Aktionen im Audit-Log oder Sprachsitzungen.
        Belege = neu angelegte Verkäufe, Bestellungen, Fertigungs- und
        Reparaturaufträge, Lieferantenrechnungen. KI-Fragen = Chat-Runden und
        ausgeführte KI-Aktionen. Diese Zahlen bleiben in dieser Instanz —
        es gibt keine automatische Übermittlung.
      </p>
    </>
  )
}
