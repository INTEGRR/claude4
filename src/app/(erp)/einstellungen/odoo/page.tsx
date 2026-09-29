import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { odooKonfiguriert } from '@/modules/migration/odoo/api'
import { dateTime, qty } from '@/modules/shared/format'
import { OdooUebernahme } from './odoo-uebernahme'

export const dynamic = 'force-dynamic'

async function vorschauLaden() {
  'use server'
  return serverAktion('integrationen.odoo_vorschau', {})
}

async function uebernehmen() {
  'use server'
  return serverAktion('integrationen.odoo_stuecklisten_uebernehmen', {})
}

/**
 * Odoo-Übernahme (0090): nur Stücklisten, ihre Komponenten, Lieferanten und
 * Bestände — per API aus dem laufenden Odoo, zugeordnet per SKU an die
 * Artikel, die schon aus Shopify in KRNL sind. Kunden und Belege nicht.
 */
export default async function OdooPage() {
  await requireArea('einstellungen')
  const angebunden = odooKonfiguriert()
  const [stand] = await sql<{ boms: number; angelegt: number; zugeordnet: number; zuletzt: string | null }[]>`
    select (select count(*)::int from boms where herkunft = 'odoo' and active) as boms,
           (select count(*)::int from odoo_verweise where herkunft = 'angelegt' and odoo_tabelle = 'product_product') as angelegt,
           (select count(*)::int from odoo_verweise where herkunft = 'zugeordnet' and odoo_tabelle = 'product_product') as zugeordnet,
           (select max(created_at)::text from boms where herkunft = 'odoo') as zuletzt`

  return (
    <>
      <EinstellungenKopf href="/einstellungen/odoo" />

      <div className="notice info">
        Übernommen werden <strong>nur</strong> Stücklisten mit ihren Komponenten, Lieferanten und Beständen —
        keine Kunden, keine Belege. Fertigprodukte (Tastaturen, Switch-Tester) werden per SKU den Artikeln
        zugeordnet, die schon aus Shopify da sind; fehlt eine SKU in KRNL, wird nichts angelegt. Bestehende
        Artikel werden nie umbenannt; Einkaufspreis und Bestand nur gesetzt, wo KRNL 0 hat. Von Hand angelegte
        Stücklisten bleiben. KRNL liest Odoo nur — es schreibt nichts zurück.
      </div>

      <Card title="Übernahme">
        {angebunden ? (
          <OdooUebernahme vorschauLaden={vorschauLaden} uebernehmen={uebernehmen} />
        ) : (
          <p className="small" style={{ margin: 0 }}>
            Odoo ist nicht angebunden. In Vercel <span className="mono">ODOO_URL</span>,{' '}
            <span className="mono">ODOO_DB</span>, <span className="mono">ODOO_USER</span> und{' '}
            <span className="mono">ODOO_API_KEY</span> setzen (API-Schlüssel: Odoo → Einstellungen → Benutzer →
            Kontosicherheit → „Neuer API-Schlüssel") und neu deployen. Stand unter Einstellungen → Schnittstellen.
          </p>
        )}
      </Card>

      <Card title="Stand">
        <p className="small" style={{ margin: 0 }}>
          {qty(stand.boms)} aktive Stückliste(n) aus Odoo · {qty(stand.angelegt)} Komponente(n) angelegt ·{' '}
          {qty(stand.zugeordnet)} Artikel zugeordnet
          {stand.zuletzt ? ` · zuletzt ${dateTime(stand.zuletzt)}` : ''}. Ein weiterer Lauf ersetzt nur
          Stücklisten, die er selbst geschrieben hat und die sich in Odoo geändert haben.
        </p>
      </Card>
    </>
  )
}
