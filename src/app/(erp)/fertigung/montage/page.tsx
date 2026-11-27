import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { PageHeader } from '@/components/ui'
import { MontageBrett } from '@/components/montage-brett'
import { montageStand } from '@/modules/fertigung/montage'
import { serverAktion } from '@/modules/prozesse/server-aktion'

export const dynamic = 'force-dynamic'

async function ebenenSetzen(formData: FormData) {
  'use server'
  return serverAktion('fertigung.montage_ebenen_setzen', { formData })
}

/**
 * Montage-Übersicht (0141, Entscheidungslog 2026-11-27): was noch zu bauen
 * ist, live und gruppiert — damit die Montage Gleiches am Stück vorbereitet.
 * Die Zahlen kommen aus den offenen Fertigungsaufträgen; die Gruppierung
 * ist eine Einstellung.
 */
export default async function MontagePage() {
  const user = await requireArea('fertigung')
  const darf = canWrite(user.rollen, 'fertigung', user.befugnisse)
  const stand = await montageStand()
  const e = stand.einstellung

  return (
    <>
      <PageHeader
        title="Montage-Übersicht"
        subtitle="Was noch zu bauen ist — live aus den offenen Fertigungsaufträgen, gruppiert zum Vorbereiten am Stück"
      />
      <MontageBrett anfang={stand} />
      {darf && (
        <details className="montage-einstellung">
          <summary className="small">Gruppierung ändern</summary>
          <ActionForm action={ebenenSetzen}>
            <div className="row">
              <label className="field">
                <span>1. Ebene: Stichwörter im Produktnamen</span>
                <input name="name_teile" defaultValue={e.nameTeile.join(', ')} placeholder="z. B. HE, MX" />
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Weitere Ebenen: Attribute in dieser Reihenfolge</span>
                <input name="attribute" defaultValue={e.attribute.join(', ')} placeholder="z. B. Mounting Plate, Switches" />
              </label>
              <div className="shrink field">
                <button type="submit">Speichern</button>
              </div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Mit Komma trennen. Leer = diese Ebene entfällt.
              {stand.attributeBekannt.length > 0 && <> Attribute der offenen Aufträge: {stand.attributeBekannt.join(', ')}.</>}
            </p>
          </ActionForm>
        </details>
      )}
    </>
  )
}
