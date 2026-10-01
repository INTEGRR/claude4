import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { groesseText } from '@/components/dokumente'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { DATEV_STATUS, type DatevStatus } from '@/modules/einkauf/datev'
import { date, dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'bereit', label: 'Bereit', filter: ['bereit'] },
  { key: 'fehlt_beleg', label: 'Beleg fehlt', filter: ['fehlt_beleg'] },
  { key: 'uebergeben', label: 'Übergeben', filter: ['uebergeben'] },
  { key: 'alle', label: 'Alle', filter: ['bereit', 'fehlt_beleg', 'uebergeben'] },
] as const

/**
 * DATEV-Vorbereitung (0108): was an DATEV ginge — gebuchte
 * Lieferantenrechnungen mit verknüpfter Rechnungsdatei („bereit"), ohne
 * Datei („Beleg fehlt") und schon übergebene. NUR ÜBERSICHT: versendet wird
 * nichts, bis die Beleg-Mail mit dem Steuerberater geklärt ist (Betreiber
 * 2026-10-01). Die Rechnungsdatei hängt man an der Rechnung an (Art
 * „Rechnung").
 */
export default async function DatevPage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  await requireArea('einkauf')
  const { ansicht: roh } = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === roh) ?? ANSICHTEN[0]

  const [rows, zaehler] = await Promise.all([
    sql<
      {
        vendor_bill_id: string
        number: string
        vendor_id: string
        lieferant: string
        purchase_order_id: string | null
        bestellung: string | null
        bill_date: string | null
        rechnung_status: string
        dokument_name: string | null
        groesse: number | null
        datev_uebergeben_am: string | null
        status: DatevStatus
      }[]
    >`
      select d.vendor_bill_id, d.number, d.vendor_id, pa.name as lieferant, d.purchase_order_id, po.number as bestellung,
             d.bill_date::text as bill_date, d.rechnung_status, d.dokument_name, d.groesse,
             d.datev_uebergeben_am::text as datev_uebergeben_am, d.status
      from einkauf_datev_vorbereitung d
      join partners pa on pa.id = d.vendor_id
      left join purchase_orders po on po.id = d.purchase_order_id
      where d.status = any(${ansicht.filter as unknown as string[]})
      order by d.bill_date desc nulls last, d.number desc
      limit 500`,
    sql<{ status: DatevStatus; n: number }[]>`select status, count(*)::int as n from einkauf_datev_vorbereitung group by status`,
  ])
  const anzahl = (s: DatevStatus) => zaehler.find((z) => z.status === s)?.n ?? 0

  return (
    <>
      <PageHeader
        title="DATEV-Vorbereitung"
        subtitle="Welche gebuchten Lieferantenrechnungen mit Beleg an DATEV gehen würden"
        actions={
          <Link className="btn" href="/einkauf/rechnungen">
            Rechnungen
          </Link>
        }
      />
      <div className="notice info">
        Vorbereitet, noch nicht aktiv: KRNL sendet nichts an DATEV. Der Versand (eine Beleg-Mail je Rechnung an die
        DATEV-Upload-Adresse) folgt nach Klärung mit dem Steuerberater. Bis dahin zeigt diese Seite, wo die Rechnungsdatei
        noch fehlt — angehängt wird sie an der Rechnung (Dokumentart „Rechnung").
      </div>
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/datev?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
              {a.key !== 'alle' ? ` ${anzahl(a.key as DatevStatus)}` : ''}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Rechnungen in dieser Ansicht.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Rechnung</th>
                  <th>Lieferant</th>
                  <th>Bestellung</th>
                  <th>Datum</th>
                  <th>Beleg</th>
                  <th>DATEV</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.vendor_bill_id}:${r.dokument_name ?? ''}`}>
                    <td>
                      <Link className="mono" href={`/einkauf/rechnungen/${r.vendor_bill_id}`}>
                        {r.number}
                      </Link>
                      <div className="muted small">{r.rechnung_status === 'paid' ? 'bezahlt' : 'gebucht'}</div>
                    </td>
                    <td className="small">
                      <Link href={`/einkauf/lieferanten/${r.vendor_id}`}>{r.lieferant}</Link>
                    </td>
                    <td className="small">
                      {r.purchase_order_id ? (
                        <Link className="mono" href={`/einkauf/${r.purchase_order_id}`}>
                          {r.bestellung}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="small nowrap">{date(r.bill_date)}</td>
                    <td className="small">
                      {r.dokument_name ? (
                        <>
                          {r.dokument_name}
                          {r.groesse ? <span className="muted"> · {groesseText(r.groesse)}</span> : null}
                        </>
                      ) : (
                        <Link href={`/einkauf/rechnungen/${r.vendor_bill_id}`}>Rechnungsdatei anhängen</Link>
                      )}
                    </td>
                    <td className="nowrap">
                      <Badge state={r.status} kind="datev" title={DATEV_STATUS[r.status]} />
                      {r.datev_uebergeben_am && <div className="muted small">{dateTime(r.datev_uebergeben_am)}</div>}
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
