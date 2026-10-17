import Link from 'next/link'
import { Card, PageHeader } from '@/components/ui'

/**
 * 404 im Seitenrahmen (UX-Audit A01): ein Beleg, den es nicht (mehr) gibt —
 * gelöscht, falscher Link, falsche Nummer. Navigation bleibt sichtbar.
 */
export default function BelegNichtGefunden() {
  return (
    <>
      <PageHeader kicker="Fehler 404" title="Nicht gefunden" />
      <Card>
        <p style={{ marginTop: 0 }}>
          Diesen Beleg bzw. diese Seite gibt es nicht — vielleicht wurde er gelöscht oder der Link ist veraltet.
          Über die Navigation oder die Suche geht es weiter.
        </p>
        <Link className="btn primary" href="/">Zur Übersicht</Link>
      </Card>
    </>
  )
}
