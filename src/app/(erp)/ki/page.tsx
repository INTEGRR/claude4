import { requireArea } from '@/modules/auth'
import { kiConfigured } from '@/modules/ki/agent'
import { PageHeader } from '@/components/ui'
import { KiChat } from './chat'

export const dynamic = 'force-dynamic'

export default async function KiPage({
  searchParams,
}: {
  searchParams: Promise<{ frage?: string }>
}) {
  await requireArea('ki')
  const { frage } = await searchParams
  const aktiv = kiConfigured()

  return (
    <>
      <PageHeader
        title="KI-Analyse"
        subtitle="Auswertungen, Listen und Diagramme auf Zuruf — lesend auf allen ERP-Daten; Anlegen nur nach Bestätigung"
      />
      {aktiv ? (
        <KiChat startFrage={frage} />
      ) : (
        <div className="notice info">
          Die KI-Analyse ist noch nicht konfiguriert. In der Umgebung
          <code className="mono"> ANTHROPIC_API_KEY </code> setzen (Schlüssel aus der Anthropic Console),
          dann steht der Agent hier bereit. Alle anderen Module laufen unabhängig davon.
        </div>
      )}
    </>
  )
}
