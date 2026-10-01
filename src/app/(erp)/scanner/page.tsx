import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { PageHeader } from '@/components/ui'
import { dhlConfigured } from '@/modules/versand/dhl'
import { ScanArbeitsplatz } from './arbeitsplatz'

export const dynamic = 'force-dynamic'

export default async function ScannerPage() {
  const user = await requireArea('scanner')
  const canPickings = canWrite(user.rollen, 'lager')
  const canMos = canWrite(user.rollen, 'fertigung')
  const canVersand = canWrite(user.rollen, 'versand', user.befugnisse)
  const dhlBereit = dhlConfigured()

  // Typenschild: welche Belege dieses Gerät annimmt — und ob Labels gehen.
  const arten = [canVersand && 'Packzettel', canPickings && 'WH/…', canMos && 'MO/…'].filter(Boolean)

  return (
    <>
      <PageHeader
        title="Scannen"
        subtitle="Eine Nummer, der passende Ablauf: Packzettel → packen und Label · Wareneingang → einbuchen · Fertigungsauftrag → fertig melden"
        actions={
          <>
            <span className="led ok" />
            <span className="mono-label">{arten.join(' · ')}</span>
            {canVersand && (
              <>
                <span className={`led ${dhlBereit ? 'ok' : 'warn'}`} />
                <span className="mono-label">{dhlBereit ? 'DHL bereit' : 'DHL fehlt'}</span>
              </>
            )}
          </>
        }
      />
      <ScanArbeitsplatz canPickings={canPickings} canMos={canMos} canVersand={canVersand} />
    </>
  )
}
