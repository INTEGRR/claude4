import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'

export const dynamic = 'force-dynamic'

async function shopifyModusSpeichern(formData: FormData) {
  'use server'
  // Registry-Aktion, damit der Wechsel auditiert ist (wer hat wann scharf geschaltet).
  return serverAktion('einstellungen.shopify_modus_setzen', { formData })
}

export default async function SchnittstellenPage() {
  await requireArea('einstellungen')
  const shopify = await einstellung<{ modus: string }>('shopify')
  const modus = shopify.modus === 'schreiben' ? 'schreiben' : 'lesen'

  return (
    <>
      <EinstellungenKopf href="/einstellungen/anbindungen" />

      <Card title="Shopify: lesen oder schreiben">
        <ActionForm action={shopifyModusSpeichern}>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
              <input type="radio" name="modus" value="lesen" defaultChecked={modus === 'lesen'} />
              <span>
                <strong>Nur lesen (Staging)</strong> — Bestellungen, Kunden und Produkte kommen herein;
                Fulfillments, Tracking, Bestände, Produktänderungen und Webhook-Registrierung gehen
                nicht hinaus. Der Shop bleibt beim Altsystem.
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="radio" name="modus" value="schreiben" defaultChecked={modus === 'schreiben'} />
              <span>
                <strong>Schreiben (scharf)</strong> — KRNL meldet Fulfillments mit Tracking, Bestände
                und Produkte an den Shop zurück. Ab dem Stichtag.
              </span>
            </label>
          </fieldset>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gilt sofort, kein Redeploy nötig. Schreibjobs aus der Lesezeit werden als „übersprungen"
          abgehakt und laufen nicht nach — nach dem Scharfschalten einmal im{' '}
          <Link href="/integrationen">Ereignis-Monitor</Link> „Mit Shopify abgleichen" (Bestand) und
          Webhooks registrieren.
        </p>
      </Card>
    </>
  )
}
