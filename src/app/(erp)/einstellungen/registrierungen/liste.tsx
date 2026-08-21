'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui'
import { standSetzen } from './actions'

export interface Registrierung {
  id: string
  firma: string
  ansprechpartner: string
  email: string
  telefon: string | null
  nutzer: string | null
  heutiges_system: string | null
  ablauf: string
  status: string
  notiz: string | null
  bearbeitet_durch: string | null
  eingang: string
}

const STAENDE = ['offen', 'kontaktiert', 'erledigt', 'abgelehnt'] as const

const ABZEICHEN: Record<string, string> = {
  offen: 'warn',
  kontaktiert: 'neutral',
  erledigt: 'success',
  abgelehnt: 'neutral',
}

export function Liste({ zeilen }: { zeilen: Registrierung[] }) {
  const router = useRouter()
  const [fehler, setFehler] = useState<string | null>(null)
  const [laeuft, starten] = useTransition()

  function setzen(id: string, formData: FormData) {
    starten(async () => {
      const res = await standSetzen(id, formData)
      setFehler(res && 'error' in res ? res.error : null)
      // Die Liste ist sortiert und zeigt den Stand — nach dem Setzen muss sie
      // neu vom Server kommen, sonst steht im Auswahlfeld noch der alte Wert.
      if (!(res && 'error' in res)) router.refresh()
    })
  }

  return (
    <>
      {fehler && (
        <div className="notice danger" role="alert">{fehler}</div>
      )}
      {zeilen.map((z) => (
        <Card
          key={z.id}
          title={`${z.firma} — ${z.ansprechpartner}`}
          actions={
            <>
              <span className="muted small">{z.eingang}</span>
              <span className={`badge ${ABZEICHEN[z.status] ?? 'neutral'}`}>{z.status}</span>
            </>
          }
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            <a href={`mailto:${z.email}`}>{z.email}</a>
            {z.telefon && <> · {z.telefon}</>}
            {z.nutzer && <> · Nutzer: {z.nutzer}</>}
            {z.heutiges_system && <> · Heute: {z.heutiges_system}</>}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{z.ablauf}</p>
          {z.notiz && (
            <p className="muted small">
              Notiz: {z.notiz}
              {z.bearbeitet_durch && <> — {z.bearbeitet_durch}</>}
            </p>
          )}
          <form
            key={z.status}
            className="row"
            style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
            action={(fd) => setzen(z.id, fd)}
          >
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label htmlFor={`stand-${z.id}`}>Stand</label>
              <select id={`stand-${z.id}`} name="status" defaultValue={z.status}>
                {STAENDE.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 260px' }}>
              <label htmlFor={`notiz-${z.id}`}>Notiz</label>
              <input id={`notiz-${z.id}`} name="notiz" placeholder="Termin am … / kein Bedarf" />
            </div>
            <button type="submit" style={{ flex: 'none' }} disabled={laeuft}>
              {laeuft ? 'Speichert …' : 'Übernehmen'}
            </button>
          </form>
        </Card>
      ))}
    </>
  )
}
