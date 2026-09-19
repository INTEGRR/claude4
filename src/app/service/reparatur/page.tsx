import type { Metadata } from 'next'
import Link from 'next/link'
import { sql } from '@/db/client'
import { HexcoreMark, Wortmarke } from '@/components/marke'
import { Anfrageformular } from './anfrageformular'
import '../../start/start.css'

/**
 * Reparaturanfrage für Kunden — die zweite öffentliche Seite neben /start.
 * Liegt bewusst AUSSERHALB der (erp)-Gruppe (keine Anmeldung, kein
 * ERP-Rahmen) und teilt sich die Optik der Startseite (.krnl-start), damit
 * beide später als ein Deployment herausgezogen werden können.
 *
 * Der Prozess-Schalter ist der Formular-Schalter: ist reparatur_anfrage
 * abgeschaltet (Paketwechsel), zeigt die Seite das statt eines Formulars,
 * dessen Absenden ins Leere liefe — Chamäleon bis nach außen.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Reparatur anfragen',
  description:
    'Reparaturanfrage: Kontakt, Adresse und Fehlerbeschreibung angeben — wir melden uns mit einem Retourenlabel.',
  robots: { index: false },
}

export default async function ReparaturAnfrageSeite() {
  const [prozess] = await sql<{ aktiv: boolean }[]>`
    select aktiv from prozesse where code = 'reparatur_anfrage' and modell = 'vorgang'`
  const [firma] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  const verfuegbar = Boolean(prozess?.aktiv)

  return (
    <div className="krnl-start">
      <header className="kopf">
        <div className="bahn">
          <Link href="/start" className="marke">
            <HexcoreMark groesse={26} variante="einfach" />
            <Wortmarke groesse={20} />
          </Link>
          <nav>
            <span className="mono">Service · Reparatur</span>
          </nav>
        </div>
      </header>

      <main>
        <section className="held" style={{ paddingBottom: 48 }}>
          <div className="bahn">
            <div className="statusstreifen">
              <span className="mono">
                <span className="punkt" /> {firma?.name ?? 'Service'} · Reparaturanfrage
              </span>
            </div>
            <div style={{ maxWidth: 720 }}>
              <h1 style={{ marginTop: 18 }}>Etwas kaputt? Wir schauen uns das an.</h1>
              <p>
                Beschreiben Sie kurz, was nicht funktioniert, und geben Sie Ihre Adresse an.
                Wir prüfen die Anfrage und schicken Ihnen ein <strong>Retourenlabel</strong> per
                E-Mail — bitte senden Sie das Gerät erst danach. Nach der Reparatur geht es an
                dieselbe Adresse zurück.
              </p>
              <p className="hinweis" style={{ marginTop: 8 }}>
                Innerhalb der Garantie ist die Reparatur kostenlos. Andernfalls erhalten Sie vor
                der Rücksendung ein Angebot.
              </p>
            </div>
          </div>
        </section>

        <section style={{ paddingBottom: 96 }}>
          <div className="bahn">
            <div style={{ maxWidth: 720 }}>
              {verfuegbar ? (
                <Anfrageformular />
              ) : (
                <div className="anzeige">
                  <p className="mono" style={{ margin: '0 0 10px' }}>{'// Derzeit nicht verfügbar'}</p>
                  <h3 style={{ fontSize: 23, margin: '0 0 8px', color: '#f4f3ef' }}>
                    Reparaturanfragen nehmen wir gerade nicht online entgegen.
                  </h3>
                  <p style={{ color: '#9a9c9f', margin: 0 }}>
                    Bitte melden Sie sich per E-Mail — wir helfen trotzdem weiter.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="bahn">
          <span className="mono">
            {firma?.name ?? 'KRNL'} · Ihre Daten werden nur zur Bearbeitung der Reparatur verwendet.
          </span>
        </div>
      </footer>
    </div>
  )
}
