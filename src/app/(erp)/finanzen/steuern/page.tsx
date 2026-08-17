import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'
import { steuerZahlen, ustVorschlagUebernehmen } from '../actions'

export const dynamic = 'force-dynamic'

const ART: Record<string, string> = {
  ust: 'USt',
  gewst: 'GewSt',
  kst: 'KSt',
  sonstige: 'Sonstige',
}

/**
 * Steuertermine: manuell erfasst, die USt-Zahllast zusätzlich aus den
 * Belegen VORGESCHLAGEN — mit sichtbarem Rechenweg, übernommen wird
 * bewusst per Klick, gebucht nie automatisch.
 */
export default async function SteuernSeite() {
  await requireArea('finanzen')

  const termine = await sql<
    { id: string; art: string; zeitraum_von: string; zeitraum_bis: string;
      bezeichnung: string; betrag: number; faellig_am: string;
      quelle: string; bezahlt_am: string | null }[]
  >`
    select id, art, zeitraum_von, zeitraum_bis, bezeichnung, betrag,
           faellig_am, quelle, bezahlt_am
    from steuerzahlungen
    order by bezahlt_am is not null, faellig_am`

  // Vorschlag für den Vormonat — nur wenn noch kein Termin existiert.
  const [vormonat] = await sql<
    { monat: string; umsatzsteuer: number; vorsteuer: number; zahllast: number;
      faellig_am: string; existiert: boolean }[]
  >`
    with m as (select (date_trunc('month', current_date) - interval '1 month')::date as monat)
    select m.monat::text, v.*,
           exists (select 1 from steuerzahlungen s
                   where s.art = 'ust' and s.zeitraum_von = m.monat) as existiert
    from m, lateral ust_zahllast_vorschlag(m.monat) v`

  return (
    <>
      <PageHeader
        title="Steuern"
        subtitle="Termine manuell erfassen — die USt-Zahllast wird aus den Belegen vorgeschlagen"
        actions={
          <Link className="btn small" href="/aktion/finanzen.steuer_erfassen">
            Steuertermin erfassen
          </Link>
        }
      />

      {!vormonat.existiert && (
        <Card title={`USt-Vorschlag ${date(vormonat.monat).slice(3)}`}>
          <div className="row" style={{ alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              Umsatzsteuer <span className="mono">{money(vormonat.umsatzsteuer)}</span>
              {' − '}Vorsteuer <span className="mono">{money(vormonat.vorsteuer)}</span>
              {' = '}Zahllast{' '}
              <span className="mono" style={{ fontWeight: 650 }}>{money(vormonat.zahllast)}</span>
              {' · '}fällig am <span className="mono">{date(vormonat.faellig_am)}</span>
              <div className="muted small" style={{ marginTop: 4 }}>
                Geschätzt aus bestätigten Verkäufen und gebuchten Lieferantenrechnungen des
                Monats — nach dem Übernehmen frei anpassbar.
              </div>
            </div>
            <div className="shrink">
              <ActionButton
                className="wichtig"
                action={ustVorschlagUebernehmen.bind(null, vormonat.monat)}
              >
                Als Termin übernehmen
              </ActionButton>
            </div>
          </div>
        </Card>
      )}

      <Card title="Steuertermine" tight>
        {termine.length === 0 ? (
          <Empty>Noch keine Steuertermine erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Bezeichnung</th>
                  <th>Zeitraum</th>
                  <th>Fällig</th>
                  <th style={{ textAlign: 'right' }}>Betrag</th>
                  <th>Quelle</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {termine.map((s) => (
                  <tr key={s.id} style={s.bezahlt_am ? { opacity: 0.55 } : undefined}>
                    <td className="mono">{ART[s.art] ?? s.art}</td>
                    <td>{s.bezeichnung}</td>
                    <td className="mono muted">
                      {date(s.zeitraum_von)} – {date(s.zeitraum_bis)}
                    </td>
                    <td className="mono muted">{date(s.faellig_am)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {Number(s.betrag) < 0 ? '+' : ''}{money(Math.abs(Number(s.betrag)))}
                      {Number(s.betrag) < 0 && <span className="muted small"> Erstattung</span>}
                    </td>
                    <td className="muted">{s.quelle}</td>
                    <td>
                      {s.bezahlt_am ? (
                        <><span className="led ok" /> {date(s.bezahlt_am)}</>
                      ) : (
                        <><span className="led warn" /> offen</>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!s.bezahlt_am && (
                        <ActionButton className="small" action={steuerZahlen.bind(null, s.id)}>
                          Beglichen
                        </ActionButton>
                      )}
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
