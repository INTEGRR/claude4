import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap, Zustand } from '@/components/ui'
import { GroesseBehalten, Seiten } from '@/components/seiten'
import { seitenHref, seitenParameter } from '@/modules/shared/seiten'
import { type JaNein, zuordnungen, zuordnungZahlen } from '@/modules/integrationen/zuordnung'
import { qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

type Parameter = { shop?: string; odoo?: string; sku?: string; archiv?: string; q?: string; seite?: string; pro?: string }
const PFAD = '/produkte/zuordnung'
const jn = (v: string | undefined): JaNein => (v === 'ja' || v === 'nein' ? v : null)

/** Kurzform einer Shopify-GID: die Nummer am Ende. */
const nummer = (gid: string) => gid.replace(/^.*\//, '')

/**
 * Zuordnungen (2026-11-27): eine Liste aller Artikel mit ihren Verknüpfungen
 * zu Shopify und Odoo — und den Lücken. Filter, Suche und Seiten stehen in
 * der Adresse. Geändert wird an der Variante (Klick auf den Namen).
 */
export default async function ZuordnungPage({ searchParams }: { searchParams: Promise<Parameter> }) {
  await requireArea('produkte')
  const params = await searchParams
  const filter = { shop: jn(params.shop), odoo: jn(params.odoo), sku: jn(params.sku), archiv: params.archiv === '1', q: params.q ?? '' }
  const seite = seitenParameter(params)
  const [{ zeilen, gesamt }, zahlen] = await Promise.all([zuordnungen(filter, seite), zuordnungZahlen()])

  const href = (aenderung: Partial<Parameter>) => seitenHref(PFAD, { ...params, ...aenderung, seite: undefined }, 1)
  const Filter = ({ name, titel, wert }: { name: 'shop' | 'odoo' | 'sku'; titel: string; wert: JaNein }) => (
    <>
      <span className="mono-label" style={{ marginLeft: 10 }}>{titel}</span>
      {([[null, 'alle'], ['ja', 'ja'], ['nein', 'nein']] as const).map(([w, label]) => (
        <Link key={`${name}-${label}`} href={href({ [name]: w ?? undefined })} className="btn small" aria-current={wert === w ? 'true' : undefined}>
          {label}
        </Link>
      ))}
    </>
  )

  return (
    <>
      <PageHeader
        title="Zuordnungen"
        subtitle="Womit jeder Artikel verknüpft ist — Shopify, weitere Shop-Angebote, Odoo — und wo etwas fehlt"
        actions={<Link className="btn" href="/produkte">Zur Produktliste</Link>}
      />

      <div className="notice info">
        <strong>So wird zugeordnet:</strong> Bestellungen und Bestandsmeldungen laufen über die gespeicherte
        Shopify-Varianten-ID am Artikel, nicht über die Artikelnummer. Die Artikelnummer stellt die Verknüpfung nur
        einmal her (Produktimport, erste Bestellung). Weitere Shop-Angebote desselben Artikels (Bundles, Editionen)
        hängen als Zweitangebot daran und teilen sich seinen Bestand. Ändern: auf den Artikel klicken.
      </div>

      <div className="actions" style={{ margin: '0 0 12px', rowGap: 6 }}>
        <span className="small">
          <strong>{qty(zahlen.artikel)}</strong> Artikel · <strong>{qty(zahlen.mit_shop)}</strong> mit Shopify ·{' '}
          <strong>{qty(zahlen.mit_odoo)}</strong> mit Odoo · {qty(zahlen.zweitangebote)} Zweitangebote
        </span>
        {zahlen.verkaufbar_ohne_shop > 0 && (
          <Link className="btn small" href={`${PFAD}?shop=nein`}>
            <Zustand ton="warn">{qty(zahlen.verkaufbar_ohne_shop)} verkaufbar ohne Shop-Verknüpfung</Zustand>
          </Link>
        )}
        {zahlen.ohne_sku > 0 && (
          <Link className="btn small" href={`${PFAD}?sku=nein`}>
            <Zustand ton="warn">{qty(zahlen.ohne_sku)} ohne Artikelnummer</Zustand>
          </Link>
        )}
        {zahlen.ohne_alles > 0 && (
          <Link className="btn small" href={`${PFAD}?shop=nein&odoo=nein`}>
            <Zustand ton="warn">{qty(zahlen.ohne_alles)} mit Bestand oder in Stücklisten, aber ohne jede Verknüpfung</Zustand>
          </Link>
        )}
        {zahlen.klaerfaelle > 0 && (
          <Link className="btn small" href="/integrationen">
            <Zustand ton="warn">{qty(zahlen.klaerfaelle)} Shop-Positionen ohne Artikel (Klärfälle)</Zustand>
          </Link>
        )}
      </div>

      <Card tight>
        <div className="actions" style={{ padding: 12, rowGap: 8 }}>
          <span className="mono-label">Shopify</span>
          {([[null, 'alle'], ['ja', 'ja'], ['nein', 'nein']] as const).map(([w, label]) => (
            <Link key={`shop-${label}`} href={href({ shop: w ?? undefined })} className="btn small" aria-current={filter.shop === w ? 'true' : undefined}>
              {label}
            </Link>
          ))}
          <Filter name="odoo" titel="Odoo" wert={filter.odoo} />
          <Filter name="sku" titel="Artikelnummer" wert={filter.sku} />
          <Link href={href({ archiv: filter.archiv ? undefined : '1' })} className="btn small" aria-current={filter.archiv ? 'true' : undefined} style={{ marginLeft: 10 }}>
            Archivierte
          </Link>
          <form className="actions" style={{ marginLeft: 'auto', gap: 6 }}>
            {filter.shop && <input type="hidden" name="shop" value={filter.shop} />}
            {filter.odoo && <input type="hidden" name="odoo" value={filter.odoo} />}
            {filter.sku && <input type="hidden" name="sku" value={filter.sku} />}
            {filter.archiv && <input type="hidden" name="archiv" value="1" />}
            <GroesseBehalten params={params} />
            <input
              type="search"
              name="q"
              aria-label="Suche nach Name, Artikelnummer, Barcode, Shop-ID oder Odoo-ID"
              placeholder="Name, Artikelnummer, Shop- oder Odoo-ID"
              defaultValue={filter.q}
              style={{ width: 280 }}
            />
            <button type="submit" className="small">Suchen</button>
          </form>
        </div>

        {zeilen.length === 0 ? (
          <Empty>Keine Artikel für diese Auswahl.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Artikelnummer</th>
                  <th>Shopify</th>
                  <th>Weitere Shop-Angebote</th>
                  <th>Odoo</th>
                  <th className="num">Bestand</th>
                  <th className="num">in Stücklisten</th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((z) => (
                  <tr key={z.id}>
                    <td className="small">
                      <Link href={`/produkte/variante/${z.id}`}>{z.name}</Link>
                      {!z.aktiv && <span className="muted"> · archiviert</span>}
                    </td>
                    <td className="mono small">
                      {z.sku ?? <Zustand ton="warn">fehlt</Zustand>}
                      {z.barcode && <div className="muted">{z.barcode}</div>}
                    </td>
                    <td className="small">
                      {z.shopify_variant_id ? (
                        <>
                          <Zustand ton="ok">verknüpft</Zustand>
                          <div className="muted mono" title={z.shopify_variant_id}>
                            Variante {nummer(z.shopify_variant_id)}
                            {z.herausgeloest && ' · herausgelöst'}
                          </div>
                        </>
                      ) : z.verkaufbar ? (
                        <Zustand ton="warn">fehlt (verkaufbar)</Zustand>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">
                      {z.zweit.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        z.zweit.map((w, i) => (
                          <div key={`${w.produkt}-${i}`}>
                            {w.produkt ?? 'Shop-Angebot'}
                            {w.sku && <span className="muted mono"> · {w.sku}</span>}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="small">
                      {z.odoo.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        z.odoo.map((o) => (
                          <div key={o.id}>
                            <Zustand ton="ok">Odoo-Artikel {o.id}</Zustand>{' '}
                            <span className="muted">{o.herkunft === 'angelegt' ? 'aus Odoo angelegt' : 'zugeordnet'}</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="num mono">{qty(z.bestand)}</td>
                    <td className="num mono">{z.stuecklisten > 0 ? qty(z.stuecklisten) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Seiten pfad={PFAD} params={params} seite={seite} gesamt={gesamt} />
      </Card>
    </>
  )
}
