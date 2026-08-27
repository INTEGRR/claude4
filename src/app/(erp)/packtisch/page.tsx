import { requireArea } from '@/modules/auth'
import { PageHeader } from '@/components/ui'
import { dhlConfigured, dhlFehlendeVariablen } from '@/modules/versand/dhl'
import { Packtisch } from './packtisch'

export const dynamic = 'force-dynamic'

export default async function PacktischPage() {
  await requireArea('versand')
  const dhlBereit = dhlConfigured()

  return (
    <>
      <PageHeader
        title="Packtisch"
        subtitle="Versand-Code scannen → Artikel gegenscannen → Label, Warenausgang und Shop-Rückmeldung in einem Zug"
        actions={
          // Das Typenschild des Geräts: ohne DHL-Zugang kann der Abschluss
          // kein Label erstellen — das soll VOR dem ersten Scan sichtbar sein.
          <>
            <span className={`led ${dhlBereit ? 'ok' : 'warn'}`} />
            <span className="mono-label">
              {dhlBereit ? 'DHL bereit' : `DHL fehlt: ${dhlFehlendeVariablen().join(', ')}`}
            </span>
          </>
        }
      />
      <Packtisch />
    </>
  )
}
