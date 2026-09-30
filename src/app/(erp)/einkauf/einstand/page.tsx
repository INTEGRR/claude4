import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { FRACHT_MODI } from '@/modules/einkauf/einkaufsprojekt'
import { dateTime } from '@/modules/shared/format'
import { frachtsatzSetzen, zolltarifLoeschen, zolltarifSetzen } from '../projekte/actions'

export const dynamic = 'force-dynamic'

const zahl = (n: string | number, stellen = 2) =>
  Number(n).toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: 4 })

/**
 * Einstand (0097): die Sätze hinter dem Angebotsvergleich — Fracht je kg
 * und Modus (mit Mindestbetrag je Sendung) und Zollsätze je HS-Präfix.
 * Startwerte der Fracht sind Schätzungen; ab Stufe 5 verfeinern sie sich
 * aus K+N-Rechnungen und Zollbescheiden.
 */
export default async function EinstandPage() {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)

  const [fracht, zoll] = await Promise.all([
    sql<{ modus: keyof typeof FRACHT_MODI; eur_je_kg: string; mindestbetrag_eur: string; notiz: string | null; geaendert_von: string | null; updated_at: string | null }[]>`
      select modus, eur_je_kg::text, mindestbetrag_eur::text, notiz, geaendert_von, updated_at::text as updated_at
      from frachtsaetze order by array_position(array['see', 'luft', 'express'], modus)`,
    sql<{ hs_praefix: string; satz_pct: string; bezeichnung: string | null; geaendert_von: string | null }[]>`
      select hs_praefix, satz_pct::text, bezeichnung, geaendert_von from zolltarife order by hs_praefix`,
  ])

  return (
    <>
      <PageHeader
        title="Einstand"
        subtitle="Fracht- und Zollsätze für den Angebotsvergleich — Einstand = Ware × Kurs + Werkzeug/Muster + Fracht + Zoll (ohne EUSt)"
      />

      <Card title="Frachtsätze" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Modus</th>
                <th className="num">€ je kg</th>
                <th className="num">Mindestbetrag je Sendung</th>
                <th>Notiz</th>
                {darf && <th />}
              </tr>
            </thead>
            <tbody>
              {fracht.map((f) => (
                <tr key={f.modus}>
                  <td>{FRACHT_MODI[f.modus]}</td>
                  <td className="num mono">{zahl(f.eur_je_kg)}</td>
                  <td className="num mono">{zahl(f.mindestbetrag_eur)} €</td>
                  <td className="small">
                    {f.notiz ?? '—'}
                    {f.geaendert_von && (
                      <div className="muted">
                        {f.geaendert_von}
                        {f.updated_at ? `, ${dateTime(f.updated_at)}` : ''}
                      </div>
                    )}
                  </td>
                  {darf && (
                    <td>
                      <details className="small">
                        <summary>Ändern</summary>
                        <ActionForm action={frachtsatzSetzen} style={{ marginTop: 6 }}>
                          <input type="hidden" name="modus" value={f.modus} />
                          <div className="row">
                            <label className="field">
                              <span>€ je kg</span>
                              <input name="eur_je_kg" inputMode="decimal" defaultValue={zahl(f.eur_je_kg)} required />
                            </label>
                            <label className="field">
                              <span>Mindestbetrag €</span>
                              <input name="mindestbetrag_eur" inputMode="decimal" defaultValue={zahl(f.mindestbetrag_eur)} />
                            </label>
                          </div>
                          <label className="field">
                            <span>Notiz</span>
                            <input name="notiz" defaultValue={f.notiz ?? ''} />
                          </label>
                          <button type="submit" className="small">
                            Speichern
                          </button>
                        </ActionForm>
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
          Die Fracht eines Angebots = Gewicht aller Positionen × Satz, mindestens der Mindestbetrag, verteilt nach Gewicht. Bei
          D-Klauseln (DAP, DPU, DDP) zahlt der Lieferant — dann keine Fracht. Ein Angebot kann „Fracht €/Stk" fest angeben.
        </p>
      </Card>

      <Card title={`Zollsätze (${zoll.length})`} tight>
        {zoll.length === 0 ? (
          <Empty>Noch keine Zollsätze. Ohne Satz zeigt der Vergleich „kein Zollsatz" statt still 0 % anzunehmen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>HS-Präfix</th>
                  <th className="num">Satz</th>
                  <th>Bezeichnung</th>
                  {darf && <th />}
                </tr>
              </thead>
              <tbody>
                {zoll.map((z) => (
                  <tr key={z.hs_praefix}>
                    <td className="mono">{z.hs_praefix}</td>
                    <td className="num mono">{zahl(z.satz_pct, 1)} %</td>
                    <td className="small">{z.bezeichnung ?? '—'}</td>
                    {darf && (
                      <td>
                        <ActionButton action={zolltarifLoeschen.bind(null, z.hs_praefix)} className="small" confirm={`Zollsatz ${z.hs_praefix} entfernen?`}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {darf && (
          <ActionForm action={zolltarifSetzen} style={{ padding: '10px 12px' }}>
            <div className="row">
              <label className="field">
                <span>HS-Präfix</span>
                <input name="hs_praefix" className="mono" required placeholder="z. B. 8473 oder 3926 90" />
              </label>
              <label className="field">
                <span>Satz %</span>
                <input name="satz_pct" inputMode="decimal" required placeholder="6,5" />
              </label>
              <label className="field">
                <span>Bezeichnung</span>
                <input name="bezeichnung" placeholder="z. B. Kunststoffwaren" />
              </label>
              <div className="shrink field">
                <button type="submit" className="primary">
                  Speichern
                </button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Der längste passende Präfix gewinnt (8473 30 vor 8473). Zollwert = Ware + Fracht; bei DDP kein Zoll. Die
              Einfuhrumsatzsteuer ist nie Teil des Einstands.
            </p>
          </ActionForm>
        )}
      </Card>
    </>
  )
}
