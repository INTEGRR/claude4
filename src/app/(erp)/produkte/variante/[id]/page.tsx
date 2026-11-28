import { requireArea } from '@/modules/auth'
import { canAccess, canWrite, hatRolle } from '@/modules/auth/permissions'
import { ArtikelAktionen, ArtikelBestand, BewegungenKarte, EtikettKarte, VerwendungKarte } from '@/components/artikel-karten'
import { Schublade } from '@/components/schublade'
import { VorschlagKnopf } from '@/components/artikelnummer-vorschlag'
import { artikelnummerVorschlag } from '@/modules/shared/artikelnummer'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import {
  artikelBestandSetzen, artikelFertigen, artikelNachbestellen, setShopRegeln, setVariantCodes, varianteHerausloesen,
} from '../../actions'
import { ShopRegelKarte } from '@/components/shop-regel-karte'
import { artikeletikettenDrucken } from '../../../lager/actions'
import { RecordComments } from '@/components/record-comments'

export const dynamic = 'force-dynamic'

export default async function VariantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ direkt?: string }>
}) {
  const user = await requireArea('produkte')
  const { id } = await params
  const direkt = (await searchParams).direkt === '1'

  const [variant] = await sql<
    {
      id: string
      template_id: string
      product: string
      display_name: string | null
      sku: string | null
      barcode: string | null
      shopify_variant_id: string | null
      uom: string
      on_hand: number
      free: number
      incoming: number
      outgoing: number
      forecasted: number
      geschwister: number
      stueckliste: boolean
      herausgeloest: boolean
      aktiv: boolean
      kaufbar: boolean
      verkaufbar: boolean
      gefertigt: boolean
    }[]
  >`
    select pv.id, pv.template_id, pt.name as product, pv.display_name, pv.sku, pv.barcode,
           pv.shopify_variant_id, u.name as uom, pv.shop_herausgeloest as herausgeloest, (pv.active and pt.active) as aktiv,
           pt.can_be_purchased as kaufbar, pt.can_be_sold as verkaufbar, pt.route_manufacture as gefertigt,
           (select count(*)::int from product_variants x where x.template_id = pv.template_id and x.active and x.id <> pv.id) as geschwister,
           exists (select 1 from boms b where b.active and (b.variant_id = pv.id or b.template_id = pv.template_id)) as stueckliste,
           on_hand_qty(pv.id) as on_hand, free_to_use(pv.id) as free,
           incoming_qty(pv.id) as incoming, outgoing_qty(pv.id) as outgoing,
           forecasted_qty(pv.id) as forecasted
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = pt.uom_id
    where pv.id = ${id}`

  if (!variant) notFound()
  // Ein Artikel ohne Varianten hat eine Seite: das Produkt (2026-11-28). Wer aus
  // einer Liste kommt, landet dort — nicht auf der „Variante von sich selbst".
  if (variant.geschwister === 0 && variant.aktiv && !direkt) redirect(`/produkte/${variant.template_id}`)

  const label = variant.display_name ?? variant.product
  const codeValue = variant.barcode ?? variant.sku

  // Ohne Artikelnummer: Vorschlag nach dem Muster (2026-11-28).
  const skuVorschlag = variant.sku?.trim()
    ? null
    : artikelnummerVorschlag(
        { produkt: variant.display_name ?? variant.product },
        (await sql<{ sku: string }[]>`select sku from product_variants where coalesce(sku, '') <> ''`).map((x) => x.sku),
      )

  return (
    <>
      <PageHeader
        title={label}
        subtitle={
          <Link href={`/produkte/${variant.template_id}`}>zum Produkt {variant.product}</Link>
        }
        actions={
          // Herauslösen (0143): nur wo es Sinn hat — mehrere Varianten, kein gefertigtes Produkt.
          hatRolle(user.rollen, 'admin') && variant.geschwister > 0 && !variant.stueckliste ? (
            <Schublade id="herausloesen" knopf="Als eigenes Produkt herauslösen" knopfKlasse="" titel="Variante als eigenes Produkt herauslösen">
              <ActionForm action={varianteHerausloesen.bind(null, id)}>
                <p className="small" style={{ marginTop: 0 }}>
                  „{label}" wird ein eigenes Produkt. Bestand, Lagerbewegungen, Stücklisten, Belege und die
                  Artikelnummer bleiben unverändert daran; „{variant.product}" verliert diese Variante.
                  {variant.shopify_variant_id &&
                    ` Im Shop bleibt der Artikel Variante von „${variant.product}" — Bestellungen und Bestand laufen weiter, Titel und Preise werden nicht mehr abgeglichen.`}
                </p>
                <label className="field">
                  <span>Name des neuen Produkts</span>
                  <input name="name" required maxLength={200} placeholder="z. B. Cherry MX2A Silent Red" />
                </label>
                <button className="primary" type="submit">Herauslösen</button>
              </ActionForm>
            </Schublade>
          ) : undefined
        }
      />
      {variant.herausgeloest && (
        <div className="notice info">
          Dieser Artikel ist in KRNL ein eigenes Produkt, im Shop aber Variante eines anderen Produkts
          (herausgelöst). Bestellungen und Bestand laufen normal; Titel und Preise werden nicht abgeglichen.
        </div>
      )}

      {variant.aktiv && (
        <ArtikelAktionen
          varianten={[{ id, name: label }]}
          suche={variant.sku?.trim() || label}
          name={label}
          kaufbar={variant.kaufbar}
          fertigbar={variant.gefertigt && variant.stueckliste}
          verkaufbar={variant.verkaufbar}
          imShop={Boolean(variant.shopify_variant_id)}
          darf={{
            lager: canWrite(user.rollen, 'lager', user.befugnisse),
            einkauf: canWrite(user.rollen, 'einkauf', user.befugnisse),
            fertigung: canWrite(user.rollen, 'fertigung', user.befugnisse),
            verkaufSehen: canAccess(user.rollen, 'verkauf', user.befugnisse),
            lagerSehen: canAccess(user.rollen, 'lager', user.befugnisse),
          }}
          bestandSetzen={artikelBestandSetzen}
          nachbestellen={artikelNachbestellen}
          fertigen={artikelFertigen}
        />
      )}
      <ArtikelBestand variantIds={[id]} uom={variant.uom} />

      <div className="grid-2">
        <Card title="Kennzeichnung">
          <ActionForm action={setVariantCodes.bind(null, id)}>
            <label className="field" style={{ marginBottom: 4 }}>
              <span>Artikelnummer (SKU)</span>
              <input name="sku" className="mono" defaultValue={variant.sku ?? ''} placeholder={skuVorschlag ?? undefined} />
            </label>
            <div className="small muted" style={{ marginBottom: 12 }}>
              {skuVorschlag ? (
                <>Vorschlag nach dem Nummernmuster: <VorschlagKnopf feld="sku" vorschlag={skuVorschlag} /></>
              ) : (
                'Die Artikelnummer führt KRNL — der Shop überschreibt sie nicht.'
              )}
            </div>
            <label className="field" style={{ marginBottom: 4 }}>
              <span>Barcode</span>
              <input name="barcode" className="mono" defaultValue={variant.barcode ?? ''} />
            </label>
            <div className="small muted" style={{ marginBottom: 12 }}>
              EAN oder frei
            </div>
            <label className="field">
              <span>Shopify-Varianten-ID</span>
              <input
                name="shopify_variant_id"
                className="mono"
                defaultValue={variant.shopify_variant_id ?? ''}
                placeholder="gid://shopify/ProductVariant/…"
              />
            </label>
            <button className="primary" type="submit">Speichern</button>
          </ActionForm>
        </Card>

        <EtikettKarte variantId={id} code={codeValue} darfDrucken={canWrite(user.rollen, 'lager', user.befugnisse)} drucken={artikeletikettenDrucken} />
      </div>

      <ShopRegelKarte variantId={id} darf={canWrite(user.rollen, 'verkauf', user.befugnisse)} action={setShopRegeln} />

      <VerwendungKarte variantIds={[id]} />
      <BewegungenKarte variantIds={[id]} />
      <RecordComments model="product_variant" recordId={id} path={`/produkte/variante/${id}`} />
    </>
  )
}
