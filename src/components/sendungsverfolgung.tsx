import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Badge } from '@/components/ui'
import type { ActionResult } from '@/modules/shared/action'
import { dateTime } from '@/modules/shared/format'
import { type Ereignis, subStatusText, zeitKurz } from '@/modules/versand/track17-logik'
import { track17Konfiguriert } from '@/modules/versand/track17'
import { type Verfolgung, type VerfolgungModell, verfolgungLesen } from '@/modules/versand/zulauf-verfolgung'
import { kontingentStandLesen, kontingentText } from '@/modules/versand/track17-einstellung'

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
      {v.status === 'registriert' && <span className="muted"> · 17TRACK sammelt noch</span>}
      {v.status === 'vorgemerkt' && <span className="muted"> · nicht angemeldet — „Verfolgen" am Beleg</span>}
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
  // Kontingent (gemerkter Stand, kein Aufruf je Seitenansicht) — „Verfolgen" kostet eine Sendung davon.
  const kontingent = await kontingentStandLesen(sql)
  const vorgemerkt = zeilen.length === 0 || zeilen.some((v) => v.status === 'vorgemerkt')
  // Noch ohne Stand: wann fasst KRNL nach? (Job track17_nachfassen, sonst der stündliche Abruf)
  const frisch = zeilen.filter((v) => v.status === 'registriert' || v.status === 'nicht_gefunden').map((v) => v.id)
  const nachfassen = new Map<string, string>()
  if (frisch.length > 0) {
    const jobs = await sql<{ verfolgung_id: string; am: string }[]>`
      select payload ->> 'verfolgung_id' as verfolgung_id, min(next_run_at)::text as am
      from integration_jobs
      where kind = 'track17_nachfassen' and status = 'pending' and payload ->> 'verfolgung_id' in ${sql(frisch)}
      group by 1`
    for (const j of jobs) nachfassen.set(j.verfolgung_id, j.am)
  }

  return (
    <div className="info-panel" style={{ marginTop: 10 }}>
      <div className="display-head">
        <span>Sendungsverfolgung</span>
        <span>{zeilen[0] ? abgefragtText(zeilen[0]) : 'noch nie abgefragt'}</span>
      </div>
      {zeilen.length === 0 ? (
        <div className="small muted">
          <span className="mono">{nummer}</span> ist nicht bei 17TRACK angemeldet
          {angebunden ? ` — „Verfolgen" meldet die Sendung an (kostet eine Sendung vom Kontingent, ${kontingentText(kontingent)}).` : '.'}
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
            {v.aktiv && v.status === 'vorgemerkt' && (
              <div className="muted">
                Nicht bei 17TRACK angemeldet — kostet nichts, liefert aber auch keinen Stand. „Verfolgen" meldet die
                Sendung an (eine Sendung vom Kontingent, {kontingentText(kontingent)}); automatisch anmelden lässt
                sich unter <Link href="/einstellungen/anbindungen">Schnittstellen</Link> einschalten.
              </div>
            )}
            {v.aktiv && (v.status === 'registriert' || v.status === 'nicht_gefunden') && (
              <div className="muted">
                {v.status === 'registriert'
                  ? '17TRACK sammelt noch — nach der Anmeldung dauert das meist wenige Minuten.'
                  : 'Der Carrier kennt die Nummer noch nicht — oft erst, wenn das Paket abgeholt ist.'}{' '}
                Nächste Abfrage{' '}
                {nachfassen.get(v.id)
                  ? `um ${dateTime(nachfassen.get(v.id))}`
                  : 'spätestens in einer Stunde (stündlicher Abruf)'}
                {' — oder „Jetzt abfragen".'}
              </div>
            )}
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
          <ActionButton className="small" action={abfragen} title={vorgemerkt ? 'Meldet die Sendung bei 17TRACK an und holt den Stand' : undefined}>
            {vorgemerkt ? 'Verfolgen (1 vom Kontingent)' : 'Jetzt abfragen'}
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
