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
  eori: string
  ust_id: string
  registergericht: string
  handelsregister: string
  steuernummer: string
  geschaeftsfuehrung: string
  web: string
  iban: string
  bic: string
  bank: string
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
            <label className="field">
              <span>EORI-Nummer (Zoll)</span>
              <input name="eori" className="mono" defaultValue={firma.eori ?? ''} placeholder="DE…" />
            </label>
            <label className="field">
              <span>USt-IdNr.</span>
              <input name="ust_id" className="mono" defaultValue={firma.ust_id ?? ''} placeholder="DE…" />
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
          <div className="row">
            <label className="field">
              <span>Registergericht</span>
              <input name="registergericht" defaultValue={firma.registergericht ?? ''} placeholder="Bad Oeynhausen" />
            </label>
            <label className="field">
              <span>Handelsregister-Nr.</span>
              <input name="handelsregister" className="mono" defaultValue={firma.handelsregister ?? ''} placeholder="HRB 12345" />
            </label>
            <label className="field">
              <span>Steuernummer</span>
              <input name="steuernummer" className="mono" defaultValue={firma.steuernummer ?? ''} />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Geschäftsführung</span>
              <input name="geschaeftsfuehrung" defaultValue={firma.geschaeftsfuehrung ?? ''} placeholder="Vorname Name, Vorname Name" />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Website</span>
              <input name="web" defaultValue={firma.web ?? ''} placeholder="www.…" />
            </label>
            <label className="field">
              <span>IBAN</span>
              <input name="iban" className="mono" defaultValue={firma.iban ?? ''} placeholder="DE…" />
            </label>
            <label className="field">
              <span>BIC</span>
              <input name="bic" className="mono" defaultValue={firma.bic ?? ''} />
            </label>
            <label className="field">
              <span>Bank</span>
              <input name="bank" defaultValue={firma.bank ?? ''} />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Registergericht, Handelsregister, Steuernummer, Geschäftsführung und Bankverbindung stehen im Fuß jeder
          Kundenrechnung (Pflichtangaben). Steht als Absender auf jedem DHL-Label und Retourenlabel, im Kopf der Belege und in
          ausgehenden Mails. Die E-Mail-Adresse erhält außerdem die Hinweise zu neuen
          Reparaturanfragen, solange <span className="mono">REPARATUR_MAIL</span> nicht gesetzt ist.
        </p>
      </Card>
    </>
  )
}
