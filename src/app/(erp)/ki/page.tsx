import { requireArea } from '@/modules/auth'
import { kiConfigured } from '@/modules/ki/agent'
import { PageHeader } from '@/components/ui'
import { KiChat } from './chat'

export const dynamic = 'force-dynamic'

export default async function KiPage() {
  await requireArea('ki')
  const aktiv = kiConfigured()

  return (
    <>
      <PageHeader
        title="KI-Analyse"
        subtitle="Ad-hoc-Auswertungen, Listen und Übersichten auf Zuruf — mit Lesezugriff auf alle ERP-Daten"
      />
      {aktiv ? (
        <KiChat />
      ) : (
        <div className="notice info">
          Die KI-Analyse ist noch nicht konfiguriert. In der Umgebung
          <code> ANTHROPIC_API_KEY </code> setzen (Schlüssel aus der Anthropic Console),
          dann steht der Agent hier bereit. Alle anderen Module laufen unabhängig davon.
        </div>
      )}
    </>
  )
}
