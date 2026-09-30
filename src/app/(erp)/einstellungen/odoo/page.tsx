import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card } from '@/components/ui'
import { ActionButton } from '@/components/action-button'
import { fertigbestandKandidaten, fertigungsLuecken } from '@/modules/migration/odoo/fertigbestand'
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

async function fertigbestandZuruecknehmen() {
  'use server'
  return serverAktion('integrationen.odoo_fertigbestand_zuruecknehmen', {})
}

/**
 * Odoo-Übernahme (0090): nur Stücklisten, ihre Komponenten, Lieferanten und
 * Bestände — per API aus dem laufenden Odoo, zugeordnet per SKU an die
 * Artikel, die schon aus Shopify in KRNL sind. Kunden und Belege nicht.
 */
export default async function OdooPage() {
  await requireArea('einstellungen')
  const angebunden = odooKonfiguriert()
  const [kandidaten, luecken] = await Promise.all([fertigbestandKandidaten(), fertigungsLuecken()])
  const zuruecknehmen = kandidaten.filter((k) => k.echteBewegungen === 0)
  const menge = zuruecknehmen.reduce((s, k) => s + k.menge, 0)
  const reserviert = zuruecknehmen.reduce((s, k) => s + k.reserviert, 0)
  const [ruecknahme] = await sql<{ message: string; actor: string | null; created_at: string }[]>`
    select message, actor, created_at::text from audit_log
    where model = 'odoo' and message like 'Odoo-Fertigbestand zurückgenommen%'
    order by created_at desc limit 1`
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

      {(zuruecknehmen.length > 0 || luecken.length > 0) && (
        <Card title="Fertigprodukt-Bestand aus Odoo zurücknehmen">
          <p className="small" style={{ marginTop: 0 }}>
            Odoo führt Tastaturen und Switch-Tester mit Bestand, weil die Lieferungen dort nicht ausgebucht wurden —
            tatsächlich sind alle Fertigprodukte bei 0. Der Knopf setzt{' '}
            <strong>
              {qty(zuruecknehmen.length)} Variante(n) mit zusammen {qty(menge)} Stück
            </strong>{' '}
            per Inventur auf 0
            {reserviert > 0 ? `, löst vorher ${qty(reserviert)} reservierte Stück (die Lieferungen warten dann wieder)` : ''}{' '}
            und legt für{' '}
            <strong>{qty(luecken.length)} offene Auftragsposition(en)</strong> ohne Fertigungsauftrag einen an
            {luecken.length > 0 ? ` (${luecken.map((l) => `${l.nummer} ${qty(l.fehlt)}× ${l.sku ?? ''}`.trim()).join(', ')})` : ''}.
          </p>
          {kandidaten.length > zuruecknehmen.length && (
            <p className="small muted">
              Nicht angefasst ({qty(kandidaten.length - zuruecknehmen.length)}), weil ihr Bestand nicht nur aus der
              Odoo-Übernahme stammt (Eingang, Fertigung, Lieferung oder eine von Hand gezählte Inventur):{' '}
              {kandidaten
                .filter((k) => k.echteBewegungen > 0)
                .map((k) => k.sku ?? k.name)
                .join(', ')}
            </p>
          )}
          <p className="small muted">
            Halbfabrikate, die selbst Komponente sind (3D-Druck des Switch-Testers), und Zubehör ohne Stückliste
            bleiben. Alles in einer Buchung; erscheint im Lagerverlauf als Inventurkorrektur.
          </p>
          <ActionButton
            action={fertigbestandZuruecknehmen}
            className="danger"
            confirm={`${zuruecknehmen.length} Fertigprodukt-Variante(n) (${menge} Stück) auf 0 setzen und ${luecken.length} Fertigungsauftrag/-aufträge nachziehen?`}
          >
            Fertigbestand zurücknehmen, Fertigung nachziehen
          </ActionButton>
        </Card>
      )}

      <Card title="Stand">
        <p className="small" style={{ margin: 0 }}>
          {qty(stand.boms)} aktive Stückliste(n) aus Odoo · {qty(stand.angelegt)} Komponente(n) angelegt ·{' '}
          {qty(stand.zugeordnet)} Artikel zugeordnet
          {stand.zuletzt ? ` · zuletzt ${dateTime(stand.zuletzt)}` : ''}. Ein weiterer Lauf ersetzt nur
          Stücklisten, die er selbst geschrieben hat und die sich in Odoo geändert haben.
        </p>
        {ruecknahme && (
          <p className="small" style={{ margin: '8px 0 0' }}>
            Zuletzt: {ruecknahme.message} — {ruecknahme.actor ?? 'system'}, {dateTime(ruecknahme.created_at)}
          </p>
        )}
      </Card>
    </>
  )
}
