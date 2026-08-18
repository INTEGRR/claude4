'use client'

import { ActionButton, ActionForm } from '@/components/action-button'
import { TableWrap } from '@/components/ui'
import { sammlungBuchen, vorgangVerwerfen, zaehlmengeAendern } from './actions'

/**
 * Die Sichtprüfung nach der Sprachsession: hier liegt die Sammlung auf dem
 * Tisch — Zeile für Zeile gegenchecken, Zählmengen korrigieren, Unerwünschtes
 * verwerfen, dann im Bulk buchen. DAS ist der Moment, in dem aus gesprochenen
 * Absichten Buchungen werden (violett = Entscheidung).
 */

export interface PruefVorgang {
  id: string
  seq: number
  aktion: string
  label: string
  parameter: Record<string, unknown>
  /** Parameter mit deutschen Feldlabels (formularFelder, serverseitig aufgelöst). */
  werte: { label: string; wert: string }[]
  zusammenfassung: string
  status: 'offen' | 'gebucht' | 'verworfen' | 'fehler'
  ergebnis_text: string | null
}

const STATUS_LED: Record<PruefVorgang['status'], string> = {
  offen: 'led on',
  gebucht: 'led ok',
  verworfen: 'led off',
  fehler: 'led warn',
}

export function Pruefung({
  protokollId,
  begonnenAm,
  vorgaenge,
}: {
  protokollId: string
  begonnenAm: string
  vorgaenge: PruefVorgang[]
}) {
  const offen = vorgaenge.filter((v) => v.status === 'offen')
  const datum = new Date(begonnenAm).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <section className="card">
      <header>
        <span>
          Sammlung vom {datum} — {offen.length} offen
        </span>
        <span className="actions">
          <ActionButton
            className="wichtig"
            action={sammlungBuchen.bind(null, protokollId)}
            confirm={`${offen.length} offene(n) Vorgang/Vorgänge jetzt buchen?`}
            disabled={offen.length === 0}
          >
            Alle offenen buchen
          </ActionButton>
        </span>
      </header>
      <div className="body tight">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Aktion</th>
                <th>Angesagt</th>
                <th>Werte</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vorgaenge.map((v) => (
                <tr key={v.id} style={v.status === 'verworfen' ? { opacity: 0.45 } : undefined}>
                  <td className="mono muted">{v.seq}</td>
                  <td>{v.label}</td>
                  <td>{v.zusammenfassung}</td>
                  <td className="mono small muted">
                    {v.status === 'offen' && v.aktion === 'lager.zaehlung_erfassen' ? (
                      <ActionForm
                        action={zaehlmengeAendern.bind(null, v.id)}
                        style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                      >
                        <input
                          className="mono"
                          type="number"
                          name="counted_qty"
                          step="1"
                          min="0"
                          defaultValue={Number(v.parameter.counted_qty ?? 0)}
                          style={{ width: 90, textAlign: 'right' }}
                          title="Gezählte Menge — vor dem Buchen korrigierbar"
                        />
                        <button className="small" type="submit" title="Menge speichern">
                          ✓
                        </button>
                      </ActionForm>
                    ) : (
                      v.werte.map((w) => `${w.label}: ${w.wert}`).join(' · ') || '—'
                    )}
                  </td>
                  <td>
                    <span className={STATUS_LED[v.status]} style={{ marginRight: 6 }} />
                    {v.status}
                    {v.ergebnis_text && (
                      <span className="muted small"> — {v.ergebnis_text}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {v.status === 'offen' && (
                      <ActionButton className="small" action={vorgangVerwerfen.bind(null, v.id)}>
                        Verwerfen
                      </ActionButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>
    </section>
  )
}
