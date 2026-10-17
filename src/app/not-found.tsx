import Link from 'next/link'
import { HexcoreMark, Wortmarke } from '@/components/marke'

/**
 * 404 für Adressen, die es nicht gibt (UX-Audit A01: bisher die englische
 * Standardseite). Läuft ohne Anmeldung und ohne Seitenrahmen — deshalb im
 * Typenschild des Anmeldeschirms.
 */
export default function NichtGefunden() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ padding: '0 2px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HexcoreMark groesse={26} />
            <Wortmarke groesse={20} />
          </div>
          <div className="mono-label" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span className="led warn" /> Fehler 404
          </div>
        </div>
        <div className="card">
          <header>Seite nicht gefunden</header>
          <div className="body">
            <p style={{ marginTop: 0 }}>Diese Adresse gibt es in KRNL nicht — vielleicht ein alter Link oder ein Tippfehler.</p>
            <Link className="btn primary" href="/">Zur Übersicht</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
