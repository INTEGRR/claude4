import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Badge } from '@/components/ui'
import type { ActionResult } from '@/modules/shared/action'
import { dateTime } from '@/modules/shared/format'
import { type Ereignis, subStatusText, zeitKurz } from '@/modules/versand/track17-logik'
import { track17Konfiguriert } from '@/modules/versand/track17'
import { type Verfolgung, type VerfolgungModell, verfolgungLesen } from '@/modules/versand/zulauf-verfolgung'

/**
 * Zulauf-Sendungsverfolgung (0112) an Bestellung und Eingangssendung: Status,
 * letztes Ereignis, Verlauf — und immer sichtbar, WANN und WIE zuletzt
 * abgefragt wurde. „Jetzt abfragen" ruft die Registry-Aktion.
 */

const VIA_TEXT: Record<NonNullable<Verfolgung['zuletzt_abgefragt_via']>, string> = {
  registrierung: 'bei der Anmeldung',
  abruf: 'stündlicher Abruf',
  webhook: 'Meldung von 17TRACK',
  manuell: 'von Hand',
}

/** „zuletzt abgefragt 15.10.2026 06:00 (stündlicher Abruf)" bzw. „noch nie abgefragt". */
export function abgefragtText(v: Pick<Verfolgung, 'zuletzt_abgefragt_am' | 'zuletzt_abgefragt_via'>): string {
  if (!v.zuletzt_abgefragt_am) return 'noch nie abgefragt'
  const via = v.zuletzt_abgefragt_via ? ` (${VIA_TEXT[v.zuletzt_abgefragt_via]})` : ''
  return `zuletzt abgefragt ${dateTime(v.zuletzt_abgefragt_am)}${via}`
}

function ereignisText(e: Ereignis | null): string | null {
  if (!e) return null
  const wo = [e.zeit ? zeitKurz(e.zeit) : null, e.ort].filter(Boolean).join(' · ')
  return wo ? `${wo}: ${e.text}` : e.text
}

/** Eine Zeile für Listen und Karten (Zulauf-Kalender, Wareneingang). */
export function VerfolgungKurz({
  v,
}: {
  v: Pick<Verfolgung, 'status' | 'sub_status' | 'letztes_ereignis' | 'zuletzt_abgefragt_am' | 'zuletzt_abgefragt_via' | 'registrierung_fehler'>
}) {
  const zusatz = subStatusText(v.sub_status)
  return (
    <div className="small">
      <Badge state={v.status} kind="sendungsverfolgung" led />
      {zusatz && <span className="muted"> {zusatz}</span>}
      {v.letztes_ereignis && <span className="muted"> · {ereignisText(v.letztes_ereignis)}</span>}
      {v.registrierung_fehler && <span style={{ color: 'var(--danger)' }}> · {v.registrierung_fehler}</span>}
      <div className="muted small">{abgefragtText(v)}</div>
    </div>
  )
}

export async function Sendungsverfolgung({
  modell,
  recordId,
  nummer,
  abfragen,
}: {
  modell: VerfolgungModell
  recordId: string
  /** Die am Beleg gepflegte Sendungsnummer — ohne sie gibt es nichts zu verfolgen. */
  nummer: string | null
  abfragen: () => Promise<ActionResult>
}) {
  const alle = await verfolgungLesen(sql, modell, recordId)
  // Aktive zuerst; ohne aktive die jüngste stillgelegte (zugestellt, ersetzt).
  const zeilen = alle.some((v) => v.aktiv) ? alle.filter((v) => v.aktiv) : alle.slice(0, 1)
  if (zeilen.length === 0 && !nummer?.trim()) return null
  const angebunden = track17Konfiguriert()

  return (
    <div className="display-panel" style={{ marginTop: 10 }}>
      <div className="display-head">
        <span>Sendungsverfolgung</span>
        <span>{zeilen[0] ? abgefragtText(zeilen[0]) : 'noch nie abgefragt'}</span>
      </div>
      {zeilen.length === 0 ? (
        <div className="small muted">
          <span className="mono">{nummer}</span> ist noch nicht angemeldet
          {angebunden ? ' — „Jetzt abfragen" meldet die Sendung an.' : '.'}
        </div>
      ) : (
        zeilen.map((v) => (
          <div key={v.id} className="small" style={{ marginBottom: 6 }}>
            <Badge state={v.status} kind="sendungsverfolgung" led />{' '}
            {v.carrier && <>{v.carrier} </>}
            <span className="mono">{v.nummer}</span>
            {subStatusText(v.sub_status) && <span className="muted"> · {subStatusText(v.sub_status)}</span>}
            {!v.aktiv && v.status !== 'zugestellt' && v.status !== 'nicht_verfolgbar' && (
              <span className="muted"> · wird nicht mehr abgefragt</span>
            )}
            {v.letztes_ereignis && <div className="muted">{ereignisText(v.letztes_ereignis)}</div>}
            {v.registrierung_fehler && <div style={{ color: 'var(--danger)' }}>{v.registrierung_fehler}</div>}
            {v.registriert_am && (
              <div className="muted small">
                angemeldet {dateTime(v.registriert_am)}
                {v.zuletzt_geaendert_am ? ` · letzte Änderung ${dateTime(v.zuletzt_geaendert_am)}` : ''}
                {v.zugestellt_am ? ` · zugestellt ${dateTime(v.zugestellt_am)}` : ''}
              </div>
            )}
            {v.ereignisse.length > 1 && (
              <details style={{ marginTop: 4 }}>
                <summary className="small muted">Verlauf ({v.ereignisse.length})</summary>
                <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {v.ereignisse.map((e, i) => (
                    <li key={`${e.zeit ?? ''}-${i}`}>{ereignisText(e)}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))
      )}
      <div className="actions" style={{ marginTop: 6 }}>
        {angebunden ? (
          <ActionButton className="small" action={abfragen}>
            Jetzt abfragen
          </ActionButton>
        ) : (
          <span className="small muted">
            17TRACK ist nicht angebunden — <Link href="/einstellungen/anbindungen">Schnittstellen</Link>.
          </span>
        )}
      </div>
    </div>
  )
}
