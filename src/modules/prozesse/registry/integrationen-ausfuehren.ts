import { sql, tx } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'
import { plural } from '@/modules/shared/format'

/** Ausführung der Integrations-Aktionen. */

export async function klaerfallAufloesen(
  p: { variant_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const lineId = ctx.recordId!
  const [line] = await sql<
    { sku: string | null; variant_gid: string | null; shopify_order_id: string | null }[]
  >`
    select sku, variant_gid, shopify_order_id from shopify_unmatched_lines where id = ${lineId}`
  if (!line) throw new Error('Klärfall nicht gefunden.')

  // Zuordnung dauerhaft an der Variante speichern, damit der nächste Import passt.
  if (line.variant_gid) {
    await sql`update product_variants set shopify_variant_id = ${line.variant_gid}
              where id = ${p.variant_id} and shopify_variant_id is null`
  }
  if (line.sku) {
    await sql`update product_variants set sku = ${line.sku}
              where id = ${p.variant_id} and sku is null`
  }

  await sql`update shopify_unmatched_lines
            set resolved_at = now(), resolved_variant = ${p.variant_id}
            where id = ${lineId}`
  await sql`select log_event('shopify_unmatched', ${lineId}::uuid, 'state',
    'Klärfall aufgelöst', ${ctx.actor})`

  // Sofort heilen: Bestellung frisch holen und den Import erneut anwerfen —
  // der zieht die geklärte Position nach (echter Preis) und bestätigt bei
  // Bezahlung. Schlägt der Abruf fehl, holt der nächste Abgleich das nach.
  if (line.shopify_order_id) {
    try {
      const { fetchOrder } = await import('@/modules/integrationen/shopify')
      const { importShopifyOrder } = await import('@/modules/integrationen/import')
      const order = await fetchOrder(line.shopify_order_id)
      if (order) {
        const ergebnis = await importShopifyOrder(order)
        return {
          text: `Klärfall aufgelöst — ${ergebnis.message}.`,
          recordId: ergebnis.salesOrderId ?? undefined,
        }
      }
    } catch {
      // bewusst still: die Auflösung steht, der Abgleich heilt später.
    }
  }
  return { text: 'Klärfall aufgelöst — der nächste Abgleich zieht die Position nach.' }
}

/**
 * Sammelauflösung (Entscheidungslog 2026-11-23): alle offenen Klärfälle
 * eines Shop-Artikels auf einmal. Gruppe = gleiche Shop-Variante (GID),
 * ohne GID gleiche SKU und gleicher Titel. Die Bestellungen werden nicht
 * hier, sondern je Bestellung als Job nachgezogen — 200 Abrufe im Shop
 * passen in keine Anfrage, und ein gedrosselter Abruf wiederholt sich so
 * von selbst.
 */
export async function klaerfaelleAufloesen(
  p: { variant_id: string; variant_gid?: string | null; sku?: string | null; titel?: string | null },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const gid = p.variant_gid ?? null
  const sku = p.sku ?? null
  const titel = p.titel ?? null
  if (!gid && !sku && !titel) throw new Error('Kein Shop-Artikel angegeben.')

  const [variante] = await sql<{ id: string; name: string; template_id: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as name, pv.template_id
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id} and pv.active`
  if (!variante) throw new Error('Variante nicht gefunden oder nicht aktiv.')

  // Eine Transaktion: Zuordnung, Auflösung und die Nachzieh-Jobs gehören
  // zusammen — sonst stünden aufgelöste Zeilen ohne Job da.
  const { zeilen, bestellungen } = await tx(async (t) => {
    const zeilen = await t<{ id: string; shopify_order_id: string | null }[]>`
      update shopify_unmatched_lines
      set resolved_at = now(), resolved_variant = ${variante.id}
      where resolved_at is null
        and case
              when ${gid}::text is not null then variant_gid = ${gid}
              else variant_gid is null
                   and coalesce(sku, '') = coalesce(${sku}::text, '')
                   and coalesce(title, '') = coalesce(${titel}::text, '')
            end
      returning id, shopify_order_id`
    if (zeilen.length === 0) throw new Error('Zu diesem Shop-Artikel gibt es keine offenen Klärfälle mehr.')

    // Zuordnung dauerhaft an der Variante — nur wo sie frei ist (beide Spalten
    // sind eindeutig): der nächste Import passt dann ohne Klärfall.
    if (gid) {
      await t`update product_variants set shopify_variant_id = ${gid}
              where id = ${variante.id} and shopify_variant_id is null
                and not exists (select 1 from product_variants x where x.shopify_variant_id = ${gid})`
    }
    if (sku) {
      await t`update product_variants set sku = ${sku}
              where id = ${variante.id} and sku is null
                and not exists (select 1 from product_variants x where x.sku = ${sku})`
    }

    const bestellungen = [...new Set(zeilen.map((z) => z.shopify_order_id).filter((x): x is string => Boolean(x)))]
    // Eigener Schlüssel je Lauf: dieselbe Bestellung kann später für einen
    // zweiten Artikel noch einmal nachgezogen werden.
    const lauf = Date.now()
    for (const id of bestellungen) {
      await t`select enqueue_job('shopify_bestellung_nachziehen',
        ${t.json({ shopify_order_id: id })}, ${`nachziehen:${id}:${lauf}`})`
    }

    const was = titel ?? sku ?? gid
    await t`select log_event('product_template', ${variante.template_id}, 'note',
      ${`${plural(zeilen.length, 'Klärfall', 'Klärfälle')} aus dem Shop („${was}") ${variante.name} zugeordnet — ` +
        `${plural(bestellungen.length, 'Bestellung wird', 'Bestellungen werden')} nachgezogen`}, ${ctx.actor})`
    return { zeilen, bestellungen }
  })

  // Etwa 20 Bestellungen je Minute (Cron „jobs").
  const minuten = Math.max(1, Math.ceil(bestellungen.length / 20))
  return {
    text:
      `${plural(zeilen.length, 'Klärfall', 'Klärfälle')} zugeordnet. ` +
      `${plural(bestellungen.length, 'Bestellung wird', 'Bestellungen werden')} im Hintergrund nachgezogen ` +
      `und bei Bezahlung bestätigt — etwa ${plural(minuten, 'Minute', 'Minuten')}.`,
  }
}

export async function webhooksRegistrieren(
  p: { url: string },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Der Shopify-Client zieht Next-Module — dynamisch, damit der Katalog
  // unter blankem Node ladbar bleibt.
  if (process.env.SHOPIFY_FAKE === '1') {
    throw new Error('Im Fake-Betrieb (SHOPIFY_FAKE=1) gibt es keinen Shop, bei dem Webhooks registriert werden könnten')
  }
  const { registerWebhooks, shopifyConfigured } = await import('@/modules/integrationen/shopify')
  if (!shopifyConfigured()) throw new Error('Shopify ist nicht konfiguriert — siehe Einstellungen → Schnittstellen')
  const r = await registerWebhooks(p.url)
  return {
    text: `Webhooks eingerichtet: ${r.angelegt} neu, ${r.aktualisiert} umgezogen, ${r.unveraendert} passten schon.`,
  }
}

// --- Shopify-Historie und Netto-Preise (0089) --------------------------------

export async function historiePruefenAktion(p: {
  skus: string[]
  namen: string[]
}): Promise<AktionsErgebnis> {
  const { historiePruefen } = await import('../../integrationen/historie-import.ts')
  const r = await historiePruefen(p.skus, p.namen)
  return {
    text:
      `${r.unbekannteSkus.length} von ${p.skus.length} SKUs sind KRNL unbekannt` +
      ` (werden archivierte Historie-Artikel), ${r.vorhanden} Bestellungen sind schon da.`,
    daten: { ...r },
  }
}

export async function historieImportierenAktion(
  p: { bestellungen: import('../../integrationen/shopify-csv.ts').HistorieBestellung[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { historieImportieren } = await import('../../integrationen/historie-import.ts')
  const r = await historieImportieren(p.bestellungen, ctx.actor)
  return {
    text:
      `${r.angelegt} übernommen, ${r.vorhanden} schon vorhanden` +
      (r.offenJung ? `, ${r.offenJung} offen (Live-Import)` : '') +
      (r.neueArtikel ? `, ${r.neueArtikel} Historie-Artikel angelegt` : '') +
      (r.fehler.length ? ` — ${r.fehler.length} Fehler: ${r.fehler.slice(0, 2).join(' | ')}` : ''),
    daten: { ...r },
  }
}

/** Je Lauf höchstens so viele Aufträge — jeder braucht einen Shopify-Abruf. */
const NACHZIEHEN_JE_LAUF = 30

export async function shopifyPreiseNachziehen(): Promise<AktionsErgebnis> {
  const { fetchOrder } = await import('../../integrationen/shopify.ts')
  const { positionsPreis, versandNetto } = await import('../../integrationen/import.ts')
  const offen = await sql<{ id: string; gid: string; name: string | null }[]>`
    select id, shopify_order_id as gid, shopify_order_name as name
    from sales_orders
    where source = 'shopify' and shopify_order_id is not null
      and not (zusatz ? 'netto_0089')
      and not (historisch and number = shopify_order_name)   -- CSV-Historie ist schon netto
    order by order_date desc
    limit ${NACHZIEHEN_JE_LAUF}`

  let neu = 0
  const fehler: string[] = []
  for (const auftrag of offen) {
    try {
      const order = await fetchOrder(auftrag.gid)
      if (order) {
        await tx(async (t) => {
          for (const item of order.lineItems.nodes) {
            const preis = positionsPreis(item, order.taxesIncluded)
            const [variante] = await t<{ id: string }[]>`
              select id from product_variants
              where (${item.variant?.id ?? null}::text is not null and shopify_variant_id = ${item.variant?.id ?? null})
                 or (${item.sku}::text is not null and sku = ${item.sku})
              limit 1`
            if (!variante) continue
            await t`
              update sales_order_lines
              set price_unit = ${preis.stueckNetto}, tax_rate = ${preis.steuersatz}, discount = 0
              where order_id = ${auftrag.id} and variant_id = ${variante.id}`
          }
          await t`
            update sales_orders
            set versandkosten = ${versandNetto(order)},
                zusatz = zusatz || '{"netto_0089": true}'::jsonb
            where id = ${auftrag.id}`
        })
        neu++
      } else {
        await sql`update sales_orders set zusatz = zusatz || '{"netto_0089": "nicht im Shop"}'::jsonb
                  where id = ${auftrag.id}`
      }
    } catch (err) {
      fehler.push(`${auftrag.name ?? auftrag.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const [{ rest }] = await sql<{ rest: number }[]>`
    select count(*)::int as rest from sales_orders
    where source = 'shopify' and shopify_order_id is not null
      and not (zusatz ? 'netto_0089')
      and not (historisch and number = shopify_order_name)`
  return {
    text:
      `${neu} Auftrag/Aufträge auf Netto-Preise gesetzt` +
      (rest > 0 ? `, ${rest} offen — erneut ausführen` : ', alle erledigt') +
      (fehler.length ? ` — Fehler: ${fehler.slice(0, 2).join(' | ')}` : '') + '.',
  }
}

// --- Odoo-Stücklisten (0090) -------------------------------------------------

export async function odooVorschau(): Promise<AktionsErgebnis> {
  const { stuecklistenVorschau } = await import('../../migration/odoo/stuecklisten-uebernahme.ts')
  const { plan, uebersicht } = await stuecklistenVorschau()
  const komp = new Map(plan.komponenten.map((k) => [k.odooId, k]))
  return {
    text:
      `${plural(uebersicht.stuecklisten, 'Stückliste', 'Stücklisten')} für ${uebersicht.fertigZugeordnet} zugeordnete Varianten, ` +
      `${plural(uebersicht.komponentenNeu, 'neue Komponente', 'neue Komponenten')}, ${uebersicht.lagerBuchen} weitere Bestände, ${uebersicht.blockiert} blockiert.`,
    daten: {
      uebersicht,
      fertigprodukte: plan.fertigprodukte,
      blockiert: plan.blockiert,
      routen: plan.routen.map((r) => ({ skus: r.skus, fertigen: r.fertigen, aufAuftrag: r.aufAuftrag })),
      komponenten: plan.komponenten.map((k) => ({
        code: k.code,
        name: k.name,
        vorhanden: Boolean(k.krnlId),
        uom: k.uomName,
        preis: k.preis,
        bestand: k.bestand,
        lieferanten: k.lieferanten.map((l) => `${l.partnerName} ${l.preis} ${l.waehrung}`),
      })),
      stuecklisten: plan.stuecklisten.map((s) => ({
        skus: s.skus,
        jeVariante: s.variantId !== null,
        zeilen: s.zeilen.map((z) => ({
          komponente: komp.get(z.komponente)?.code ?? komp.get(z.komponente)?.name ?? String(z.komponente),
          menge: z.menge,
          uom: z.uomName,
          filter: z.filterText ?? '',
        })),
      })),
      lagerbestaende: plan.lagerbestaende.map((l) => ({
        code: l.code,
        name: l.name,
        menge: l.menge,
        krnlSku: l.krnlSku,
        preis: l.preis,
        status: l.status,
      })),
    },
  }
}

export async function odooStuecklistenUebernehmen(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { stuecklistenUebernehmen } = await import('../../migration/odoo/stuecklisten-uebernahme.ts')
  const b = await stuecklistenUebernehmen(ctx.actor)
  return {
    text:
      `${plural(b.stuecklistenNeu, 'Stückliste', 'Stücklisten')} geschrieben, ${b.stuecklistenUnveraendert} unverändert` +
      (b.stuecklistenAbgeloest ? `, ${b.stuecklistenAbgeloest} alte abgelöst` : '') + '; ' +
      `${plural(b.komponentenNeu, 'Komponente', 'Komponenten')} angelegt, ${b.komponentenZugeordnet} zugeordnet; ` +
      `${plural(b.preise, 'Preis', 'Preise')}, ${plural(b.lieferantenpreise, 'Lieferantenpreis', 'Lieferantenpreise')}, ${b.bestand + b.bestandWeitere} Bestand/Bestände, ` +
      `${plural(b.routen, 'Route', 'Routen')}` + (b.blockiert ? `; ${b.blockiert} blockiert (siehe Vorschau).` : '.'),
    daten: { ...b },
  }
}

/** Fertigprodukt-Bestand aus Odoo auf 0 (Odoo hatte Lieferungen nicht ausgebucht). */
export async function odooFertigbestandZuruecknehmen(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { fertigbestandZuruecknehmen } = await import('../../migration/odoo/fertigbestand.ts')
  const b = await fertigbestandZuruecknehmen(ctx.actor)
  return {
    text:
      `${plural(b.varianten, 'Fertigprodukt-Variante', 'Fertigprodukt-Varianten')} auf 0 gesetzt (${b.menge} Stück)` +
      (b.reservierungenGeloest ? `, ${plural(b.reservierungenGeloest, 'Reservierung', 'Reservierungen')} gelöst` : '') +
      (b.uebersprungen.length
        ? `; ${b.uebersprungen.length} mit echten Lagerbewegungen übersprungen (bitte per Inventur prüfen): ` +
          b.uebersprungen.slice(0, 5).map((u) => u.sku ?? u.name).join(', ')
        : '') +
      (b.fertigungsauftraege.length
        ? `; ${plural(b.fertigungsauftraege.length, 'Fertigungsauftrag', 'Fertigungsaufträge')} nachgezogen (` +
          b.fertigungsauftraege.map((f) => `${f.nummer} ${f.menge}× ${f.sku ?? ''}`.trim()).join(', ') + ')'
        : '') + '.',
    daten: { ...b },
  }
}

/** Aus Odoo angelegte Komponente in den gleichen Shop-Artikel zusammenführen. */
export async function odooArtikelZusammenfuehren(
  p: { aufloesen_id: string; behalten_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { artikelZusammenfuehren } = await import('../../migration/odoo/doppelte.ts')
  const b = await artikelZusammenfuehren(p.aufloesen_id, p.behalten_id, ctx.actor)
  return {
    recordId: p.behalten_id,
    text:
      `${b.von} → ${b.nach}: ${b.bestand} Stück Bestand, ${plural(b.stuecklistenzeilen, 'Stücklistenzeile', 'Stücklistenzeilen')}, ` +
      `${plural(b.offeneBewegungen, 'offene Bewegung', 'offene Bewegungen')}, ${plural(b.lieferantenpreise, 'Lieferantenpreis', 'Lieferantenpreise')} übernommen` +
      (b.preisUebernommen ? ', Einkaufspreis gesetzt' : '') +
      (b.verbrauchBleibt > 0
        ? `; ${plural(b.verbrauchBleibt, 'frühere Verbrauchsbuchung bleibt', 'frühere Verbrauchsbuchungen bleiben')} am archivierten Odoo-Artikel`
        : '') +
      (b.sku === 'sku' ? `, SKU ${b.von} übernommen` : b.sku === 'barcode' ? `, ${b.von} als Barcode` : '') + '.',
    daten: { ...b },
  }
}

/** Versand-Abgleich aller offenen Shop-Aufträge (2026-10-15) — Logik in integrationen/import.ts. */
export async function versandAbgleichenAktion(): Promise<AktionsErgebnis> {
  const { versandAbgleichen } = await import('@/modules/integrationen/import')
  const r = await versandAbgleichen(200)
  if (r.geprueft === 0 && r.nachfragen === 0) {
    return { text: 'Kein offener Shop-Auftrag ohne eigene Sendung — nichts zu prüfen, keine Nachfrage nachzulegen.' }
  }
  const teile = [
    `${r.geprueft} offene Shop-Aufträge geprüft`,
    r.nachgezogen ? `${r.nachgezogen} im Shop versendet → nachgezogen` : 'keiner im Shop versendet',
    r.nachfragen ? `${plural(r.nachfragen, 'Nachfrage', 'Nachfragen')} an die Fertigung nachgelegt` : null,
    r.fehler ? `${r.fehler} Fehler` : null,
  ].filter(Boolean)
  return {
    text: `${teile.join(', ')}.${r.meldungen.length ? ` ${r.meldungen.slice(0, 8).join(' · ')}${r.meldungen.length > 8 ? ' · …' : ''}` : ''}`,
    link: r.nachgezogen || r.nachfragen ? '/fertigung' : undefined,
  }
}
