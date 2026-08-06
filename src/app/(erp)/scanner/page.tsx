import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { PageHeader } from '@/components/ui'
import { Scanner } from './scanner'

export const dynamic = 'force-dynamic'

export default async function ScannerPage() {
  const user = await requireArea('scanner')

  return (
    <>
      <PageHeader
        title="Scanner-Arbeitsplatz"
        subtitle="Beleg scannen → Positionen abhaken → Doppelscan bestätigt und bucht"
      />
      <Scanner
        canPickings={canWrite(user.role, 'lager')}
        canMos={canWrite(user.role, 'fertigung')}
      />
    </>
  )
}
