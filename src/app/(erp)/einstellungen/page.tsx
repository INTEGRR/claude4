import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'

export const dynamic = 'force-dynamic'

interface Firma {
  name: string
  street: string
  house: string
  zip: string
  city: string
  country: string
  email: string
  phone: string
}

async function firmaSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.firma_speichern', { formData })
}

/** Einstellungen · Firma — die Wurzel der Einstellungen. */
export default async function FirmaPage() {
  await requireArea('einstellungen')
  const firma = await einstellung<Firma>('company')

  return (
    <>
      <EinstellungenKopf
        href="/einstellungen"
        actions={
          // Die Einrichtung ist nach dem Abschluss zu — Administratoren
          // kommen mit ?erneut=1 noch einmal hinein (Vorführung, Prüfung).
          <Link className="btn" href="/einrichtung?erneut=1">Einrichtung erneut ansehen</Link>
        }
      />

      <Card title="Firmendaten">
        <ActionForm action={firmaSpeichern}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Firmenname</span>
              <input name="name" defaultValue={firma.name ?? ''} required />
            </label>
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" defaultValue={firma.email ?? ''} />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" defaultValue={firma.phone ?? ''} />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" defaultValue={firma.street ?? ''} required />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house" defaultValue={firma.house ?? ''} required />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input name="zip" defaultValue={firma.zip ?? ''} required />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" defaultValue={firma.city ?? ''} required />
            </label>
            <label className="field">
              <span>Land (ISO alpha-3)</span>
              <input className="mono" name="country" defaultValue={firma.country ?? 'DEU'} maxLength={3} required />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Steht als Absender auf jedem DHL-Label und Retourenlabel, im Kopf der Belege und in
          ausgehenden Mails. Die E-Mail-Adresse erhält außerdem die Hinweise zu neuen
          Reparaturanfragen, solange <span className="mono">REPARATUR_MAIL</span> nicht gesetzt ist.
        </p>
      </Card>
    </>
  )
}
