import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { PageHeader } from '@/components/ui'
import { Scanner } from './scanner'

export const dynamic = 'force-dynamic'

export default async function ScannerPage() {
  const user = await requireArea('scanner')
  const canPickings = canWrite(user.role, 'lager')
  const canMos = canWrite(user.role, 'fertigung')

  return (
    <>
      <PageHeader
        title="Scanner-Arbeitsplatz"
        subtitle="Beleg scannen → Positionen abhaken → Doppelscan bestätigt und bucht"
        actions={
          // Berechtigungsumfang als Typenschild: welche Belegarten dieses Gerät annimmt.
          <>
            <span className="led ok" />
            <span className="mono-label">
              {canPickings && canMos ? 'WH/… · MO/…' : canPickings ? 'WH/…' : 'MO/…'}
            </span>
          </>
        }
      />
      <Scanner canPickings={canPickings} canMos={canMos} />
    </>
  )
}
