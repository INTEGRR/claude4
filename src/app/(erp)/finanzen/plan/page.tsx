import { requireWrite } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { ColumnChart } from '@/components/charts'
import { money } from '@/modules/shared/format'
import { planVorschlaegeAktualisieren, planZeileSetzen } from '../actions'

export const dynamic = 'force-dynamic'

const SZENARIEN = ['worst', 'base', 'best'] as const
const SZENARIO_LABEL: Record<string, string> = { worst: 'Worst', base: 'Basis', best: 'Best' }

/**
 * Umsatzplan-Editor: 13 Monate (laufender + 12) × drei Szenarien. Die
 * Vorschläge kommen aus umsatzplan_vorschlag() (Vorjahresmonat × Trend);
 * jede Zelle ist von Hand übersteuerbar und bleibt dann dauerhaft manuell.
 * Der Vorjahres-Ist daneben macht die Vorschläge nachrechenbar.
 */
export default async function PlanSeite() {
  await requireWrite('finanzen')

  const monate = await sql<{ monat: string; vorschlag: number }[]>`
    select ((date_trunc('month', current_date) + (n || ' months')::interval)::date)::text as monat,
           umsatzplan_vorschlag((date_trunc('month', current_date) + (n || ' months')::interval)::date) as vorschlag
    from generate_series(0, 12) n`

  const zeilen = await sql<
    { monat: string; szenario: string; umsatz_netto: number; quelle: string }[]
  >`
    select monat::text, szenario, umsatz_netto, quelle
    from umsatzplan
    where monat >= date_trunc('month', current_date)`
  const plan = new Map(zeilen.map((z) => [`${z.monat}|${z.szenario}`, z]))

  const hist = await sql<{ monat: string; netto: number }[]>`
    select (date_trunc('month', so.order_date)::date)::text as monat, sum(t.net) as netto
    from sales_orders so
    cross join lateral sales_order_total(so.id) t
    where so.state = 'sale'
    group by 1`
  const ist = new Map(hist.map((h) => [h.monat, Number(h.netto)]))
  const vorjahr = (monat: string) => {
    const d = new Date(monat)
    d.setUTCFullYear(d.getUTCFullYear() - 1)
    return ist.get(d.toISOString().slice(0, 10))
  }

  const label = (monat: string) =>
    new Date(monat).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
  const gefuellt = zeilen.length > 0

  return (
    <>
      <PageHeader
        kicker="Finanzen"
        title="Umsatzplan"
        subtitle="Monat × Szenario, netto — Vorschlag aus Vorjahr und Trend, jede Zelle übersteuerbar"
        actions={
          <ActionButton className="small" action={planVorschlaegeAktualisieren}>
            Vorschläge aktualisieren
          </ActionButton>
        }
      />

      {gefuellt && (
        <Card title="Plan (Basis) gegen Vorjahres-Ist">
          <ColumnChart
            categories={monate.map((m) => label(m.monat))}
            series={[
              {
                name: 'Plan (Basis)',
                values: monate.map((m) => Number(plan.get(`${m.monat}|base`)?.umsatz_netto ?? 0)),
              },
              {
                name: 'Vorjahr (Ist)',
                values: monate.map((m) => vorjahr(m.monat) ?? 0),
              },
            ]}
            unit="€"
          />
        </Card>
      )}

      <Card title="Planwerte" tight>
        {!gefuellt ? (
          <Empty>
            Noch kein Plan — „Vorschläge aktualisieren" füllt alle drei Szenarien aus der
            Verkaufshistorie (und läuft danach täglich im Hintergrund mit).
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Monat</th>
                  <th style={{ textAlign: 'right' }}>Vorjahr (Ist)</th>
                  <th style={{ textAlign: 'right' }}>Vorschlag</th>
                  {SZENARIEN.map((s) => (
                    <th key={s} style={{ textAlign: 'right' }}>{SZENARIO_LABEL[s]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monate.map((m) => {
                  const vj = vorjahr(m.monat)
                  return (
                    <tr key={m.monat}>
                      <td className="mono">{label(m.monat)}</td>
                      <td className="mono muted" style={{ textAlign: 'right' }}>
                        {vj != null ? money(vj) : '—'}
                      </td>
                      <td className="mono muted" style={{ textAlign: 'right' }}>
                        {money(Number(m.vorschlag))}
                      </td>
                      {SZENARIEN.map((s) => {
                        const zelle = plan.get(`${m.monat}|${s}`)
                        return (
                          <td key={s} style={{ textAlign: 'right' }}>
                            <ActionForm
                              action={planZeileSetzen}
                              style={{
                                display: 'inline-flex',
                                gap: 4,
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                              }}
                            >
                              <input type="hidden" name="monat" value={m.monat} />
                              <input type="hidden" name="szenario" value={s} />
                              {/* Handwerte tragen die violette Kante: hier hat
                                  jemand entschieden, die Automatik fasst die
                                  Zelle nie wieder an. */}
                              <input
                                className="mono"
                                type="number"
                                name="umsatz_netto"
                                step="100"
                                min="0"
                                defaultValue={zelle ? Number(zelle.umsatz_netto) : ''}
                                style={{
                                  width: 110,
                                  textAlign: 'right',
                                  ...(zelle?.quelle === 'manuell'
                                    ? { borderColor: 'var(--wichtig)' }
                                    : {}),
                                }}
                                title={
                                  zelle?.quelle === 'manuell'
                                    ? 'Von Hand gesetzt — Automatik überschreibt nicht mehr'
                                    : 'Vorschlagswert'
                                }
                              />
                              <button className="small" type="submit" title="Wert speichern">
                                ✓
                              </button>
                            </ActionForm>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
