import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireUser } from '@/modules/auth'
import { aktionsAngebot } from '@/modules/prozesse/angebote'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { aktionErlaubt } from '@/modules/prozesse/torwaechter'
import { ProzessAktionen } from '@/components/prozess-aktionen'
import { Card, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Ad-hoc-Maske (Daily-Routine): jede frei gebundene Registry-Aktion bekommt
 * ihre GENERIERTE Maske unter /aktion/<name> — das Befehlsfeld springt
 * hierher, die Maske steht sofort offen, abgeschickt wird über denselben
 * Torwächter wie überall. Keine KI im Weg: das Schema ist die Wahrheit,
 * deshalb ist die Maske in Millisekunden da.
 */
export default async function AktionsSeite({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const user = await requireUser()
  const { name } = await params
  const aktionsName = decodeURIComponent(name)

  const eintrag = registrierteAktion(aktionsName)
  if (!eintrag || eintrag.bindung !== 'frei') notFound()
  if (!aktionErlaubt(eintrag, user.role)) redirect('/?verweigert=' + eintrag.bereich)

  const angebot = await aktionsAngebot(aktionsName)
  if (!angebot) notFound()

  return (
    <>
      <PageHeader
        title={eintrag.label}
        subtitle={eintrag.beschreibung}
        actions={<Link className="btn" href="/">Zur Übersicht</Link>}
      />
      <Card title="Angaben">
        <ProzessAktionen schritte={[angebot]} sofortOffen={angebot.code} />
      </Card>
    </>
  )
}
