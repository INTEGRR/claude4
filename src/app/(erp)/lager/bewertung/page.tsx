import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { ShareBar } from '@/components/charts'
import { ActionButton } from '@/components/action-button'
import { initializeValuation } from '../actions'
import { dateTime, money, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Bestandsbewertung: Wert je Variante aus den Wertschichten, dazu die
 * jüngsten Buchungen. Der gleitende Durchschnittspreis ist das Ergebnis
 * aller Zugänge inklusive Einstandsnebenkosten.
 */

const LAYER_LABEL: Record<string, string> = {
  receipt: 'Zugang',
  issue: 'Abgang',
  landed_cost: 'Nebenkosten',
  revaluation: 'Neubewertung',
  production: 'Fertigung',
}

export default async function BewertungPage({
  searchParams,
}: {
  searchParams: Promise<{ variante?: string }>
}) {
  await requireArea('lager')
  const { variante } = await searchParams

  const bestand = await sql<
    {
      variant_id: string
      product: string
      sku: string | null
      on_hand: number
      valued_qty: number
      moving_avg_cost: number
      valuation_total: number
      qty_difference: number
    }[]
  >`select * from stock_value where valued_qty <> 0 or on_hand <> 0
    order by valuation_total desc`

  const gesamt = bestand.reduce((sum, b) => sum + Number(b.valuation_total), 0)
  const abweichungen = bestand.filter((b) => Math.abs(Number(b.qty_difference)) > 0.0001)

  const schichten = await sql<
    {
      id: string
      product: string
      layer_type: string
      quantity: number
      unit_cost: number
      value: number
      qty_after: number
      value_after: number
      note: string | null
      created_at: string
    }[]
  >`
    select l.id, variant_display_name(l.variant_id) as product, l.layer_type,
           l.quantity, l.unit_cost, l.value, l.qty_after, l.value_after,
           l.note, l.created_at
    from stock_valuation_layers l
    where (${variante ?? null}::uuid is null or l.variant_id = ${variante ?? null}::uuid)
    order by l.created_at desc
    limit 60`

  return (
    <>
      <PageHeader
        title="Bestandsbewertung"
        subtitle="Gleitender Durchschnittspreis je Variante — Ergebnis aller Zugänge, Abgänge und Nebenkosten"
        actions={
          <>
            {abweichungen.length > 0 && (
              <ActionButton
                className="primary"
                action={initializeValuation}
                confirm={`${abweichungen.length} unbewertete Position(en) zum hinterlegten Einstandspreis bewerten?`}
              >
                Altbestand bewerten
              </ActionButton>
            )}
            <Link className="btn" href="/lager/bestand">Zum Bestand</Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Bestandswert gesamt" value={money(gesamt)} hint="bewerteter Bestand" />
        <Stat
          label="Bewertete Positionen"
          value={qty(bestand.filter((b) => Number(b.valued_qty) > 0).length)}
          hint="Varianten mit Wert"
        />
        <Stat
          label="Mengenabweichungen"
          value={qty(abweichungen.length)}
          hint={
            abweichungen.length > 0
              ? 'bewertete Menge weicht vom Bestand ab'
              : 'Bestand und Bewertung im Gleichlauf'
          }
        />
      </div>

      {abweichungen.length > 0 && (
        <div className="notice warn">
          Bei {abweichungen.length} Variante(n) weicht die bewertete Menge vom physischen Bestand ab —
          typischerweise Bestand, der vor Einführung der Bewertung entstanden ist. Ohne Eröffnungs&shy;bewertung
          würden Abgänge daraus mit 0 € bewertet. „Altbestand bewerten" holt das zum hinterlegten
          Einstandspreis nach.
        </div>
      )}

      <Card title="Wertanteile" tight>
        <div style={{ padding: 12 }}>
          <ShareBar
            parts={(() => {
              const top = bestand.slice(0, 5).map((b) => ({
                label: b.product,
                value: Number(b.valuation_total),
              }))
              const rest = bestand.slice(5).reduce((sum, b) => sum + Number(b.valuation_total), 0)
              return rest > 0 ? [...top, { label: `Übrige (${bestand.length - 5})`, value: rest }] : top
            })()}
            format={(v) => money(v)}
          />
        </div>
      </Card>

      <Card title={`Bestandswert je Variante (${bestand.length})`} tight>
        {bestand.length === 0 ? (
          <Empty>Noch kein bewerteter Bestand.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Bestand</th>
                  <th className="num">Bewertet</th>
                  <th className="num">Ø Einstand</th>
                  <th className="num">Wert</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bestand.map((b) => (
                  <tr key={b.variant_id}>
                    <td>
                      <Link href={`/produkte/variante/${b.variant_id}`}>{b.product}</Link>
                      {b.sku && <span className="muted small mono"> · {b.sku}</span>}
                    </td>
                    <td className="num mono">{qty(b.on_hand)}</td>
                    <td className="num mono">
                      {qty(b.valued_qty)}
                      {Math.abs(Number(b.qty_difference)) > 0.0001 && (
                        <div className="small muted nowrap">
                          <span className="led warn" /> Abweichung {qty(b.qty_difference)}
                        </div>
                      )}
                    </td>
                    <td className="num mono">{money(b.moving_avg_cost)}</td>
                    <td className="num mono" style={{ fontWeight: 600 }}>{money(b.valuation_total)}</td>
                    <td className="num">
                      <Link className="btn small" href={`/lager/bewertung?variante=${b.variant_id}`}>
                        Schichten
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="num mono-label">Gesamt</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>{money(gesamt)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card
        title={variante ? 'Wertschichten der Variante' : 'Letzte Wertbuchungen'}
        actions={
          variante ? (
            <Link className="btn small" href="/lager/bewertung">Filter aufheben</Link>
          ) : (
            <span className="mono-label">letzte 60</span>
          )
        }
        tight
      >
        {schichten.length === 0 ? (
          <Empty>Noch keine Wertbuchungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Wann</th>
                  <th>Produkt</th>
                  <th>Art</th>
                  <th className="num">Menge</th>
                  <th className="num">Preis</th>
                  <th className="num">Wert</th>
                  <th className="num">Bestand danach</th>
                  <th>Herkunft</th>
                </tr>
              </thead>
              <tbody>
                {schichten.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap small mono">{dateTime(s.created_at)}</td>
                    <td className="small">{s.product}</td>
                    <td>
                      <span className="badge neutral">{LAYER_LABEL[s.layer_type] ?? s.layer_type}</span>
                    </td>
                    <td className="num mono">{Number(s.quantity) === 0 ? '—' : qty(s.quantity)}</td>
                    <td className="num mono">{Number(s.unit_cost) === 0 ? '—' : money(s.unit_cost)}</td>
                    <td className="num mono" style={{ color: Number(s.value) < 0 ? 'var(--text-muted)' : undefined }}>
                      {money(s.value)}
                    </td>
                    <td className="num mono small muted">
                      {qty(s.qty_after)} · {money(s.value_after)}
                    </td>
                    <td className="small muted">{s.note ?? '—'}</td>
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
