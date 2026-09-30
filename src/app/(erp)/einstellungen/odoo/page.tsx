import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, TableWrap } from '@/components/ui'
import { ActionButton, ActionForm } from '@/components/action-button'
import { fertigbestandKandidaten, fertigungsLuecken } from '@/modules/migration/odoo/fertigbestand'
import { zusammenfuehrenKandidaten } from '@/modules/migration/odoo/doppelte'
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

async function zusammenfuehren(formData: FormData) {
  'use server'
  return serverAktion('integrationen.odoo_artikel_zusammenfuehren', { formData })
}

/**
 * Odoo-Übernahme (0090): nur Stücklisten, ihre Komponenten, Lieferanten und
 * Bestände — per API aus dem laufenden Odoo, zugeordnet per SKU an die
 * Artikel, die schon aus Shopify in KRNL sind. Kunden und Belege nicht.
 */
export default async function OdooPage() {
  await requireArea('einstellungen')
  const angebunden = odooKonfiguriert()
  const [kandidaten, luecken, doppelte] = await Promise.all([
    fertigbestandKandidaten(),
    fertigungsLuecken(),
    zusammenfuehrenKandidaten(),
  ])
  const zuruecknehmen = kandidaten.filter((k) => k.echteBewegungen === 0)
  const menge = zuruecknehmen.reduce((s, k) => s + k.menge, 0)
  const reserviert = zuruecknehmen.reduce((s, k) => s + k.reserviert, 0)
  const zuletzt = await sql<{ message: string; actor: string | null; created_at: string }[]>`
    select message, actor, created_at::text from audit_log
    where model = 'odoo'
      and (message like 'Odoo-Fertigbestand zurückgenommen%' or message like 'Artikel zusammengeführt%')
    order by created_at desc limit 5`
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

      {doppelte.links.length > 0 && doppelte.rechts.length > 0 && (
        <Card title="Doppelte Artikel zusammenführen" tight>
          <p className="small" style={{ margin: 0, padding: '10px 12px' }}>
            Die Übernahme hat Komponenten neu angelegt, die es als Shop-Artikel mit anderer SKU schon gibt (z. B.
            GATERON G PRO 2.0 YELLOW = SW-GT-LY-001). Je Zeile den gleichen Shop-Artikel wählen und zusammenführen:
            Bestand, Stücklistenzeilen, offene Fertigungsbewegungen und Lieferantenpreise wandern in den Shop-Artikel,
            die Odoo-SKU wird seine SKU bzw. sein Barcode (Lager-Etiketten bleiben scanbar), die Odoo-Kopie wird
            archiviert. Vorausgewählt ist nur ein eindeutiger Namenstreffer — bitte jedes Paar prüfen.
          </p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Aus Odoo angelegt</th>
                  <th className="num">Bestand</th>
                  <th>Gleicher Shop-Artikel</th>
                </tr>
              </thead>
              <tbody>
                {doppelte.links.map((l) => (
                  <tr key={l.id}>
                    <td className="small">
                      {l.sku && <span className="mono">{l.sku}</span>} {l.name.replace(/^\[[^\]]*\]\s*/, '')}
                      {l.inStuecklisten > 0 && <div className="muted">in {qty(l.inStuecklisten)} Stückliste(n)</div>}
                    </td>
                    <td className="num mono">{qty(l.bestand)}</td>
                    <td>
                      <ActionForm action={zusammenfuehren}>
                        <input type="hidden" name="aufloesen_id" value={l.id} />
                        <div className="row">
                          <label className="field">
                            <select
                              name="behalten_id"
                              defaultValue={l.vorschlag ?? ''}
                              required
                              aria-label={`Gleicher Shop-Artikel für ${l.sku ?? l.name}`}
                            >
                              <option value="">— kein Shop-Artikel —</option>
                              {doppelte.rechts.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                  {r.sku ? ` · ${r.sku}` : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="shrink field">
                            <button type="submit" className="small">
                              Zusammenführen
                            </button>
                          </div>
                        </div>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title="Stand">
        <p className="small" style={{ margin: 0 }}>
          {qty(stand.boms)} aktive Stückliste(n) aus Odoo · {qty(stand.angelegt)} Komponente(n) angelegt ·{' '}
          {qty(stand.zugeordnet)} Artikel zugeordnet
          {stand.zuletzt ? ` · zuletzt ${dateTime(stand.zuletzt)}` : ''}. Ein weiterer Lauf ersetzt nur
          Stücklisten, die er selbst geschrieben hat und die sich in Odoo geändert haben.
        </p>
        {zuletzt.length > 0 && (
          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {zuletzt.map((z) => (
              <li key={z.created_at + z.message}>
                {z.message} — {z.actor ?? 'system'}, {dateTime(z.created_at)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
