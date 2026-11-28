import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { dateTime, label, plural, qty } from '@/modules/shared/format'
import { type BestandZeile, type Einordnung, bestandsliste } from '@/modules/integrationen/bestandsliste'
import { madeToOrderEinstellung } from '@/modules/integrationen/made-to-order'
import { shopifyModus } from '@/modules/integrationen/shopify'

export const dynamic = 'force-dynamic'

const TEXT: Record<Einordnung, { wort: string; ton: string; hinweis: string }> = {
  gleich: { wort: 'gleich', ton: 'success', hinweis: 'kaufbar bleibt kaufbar, aus bleibt aus' },
  nur_shop: { wort: 'ginge aus dem Verkauf', ton: 'danger', hinweis: 'im Shop kaufbar, KRNL würde 0 melden' },
  nur_krnl: { wort: 'ginge in den Verkauf', ton: 'warn', hinweis: 'im Shop ausverkauft, KRNL würde eine Menge melden' },
  menge: { wort: 'andere Menge', ton: 'info', hinweis: 'Lagerartikel: bleibt kaufbar, die Zahl ändert sich' },
  unsichtbar: { wort: 'im Shop nicht sichtbar', ton: 'neutral', hinweis: 'Entwurf oder archiviert' },
}

/** Abschnitte der Liste: der Status des Shop-Produkts — er entscheidet, ob Kunden das Angebot überhaupt sehen. */
const ABSCHNITTE: { status: string | null; ton: string; text: string }[] = [
  { status: 'ACTIVE', ton: 'success', text: 'im Shop sichtbar und kaufbar' },
  { status: 'UNLISTED', ton: 'info', text: 'nicht in Listen und Suche, mit direktem Link kaufbar' },
  { status: 'DRAFT', ton: 'neutral', text: 'für Kunden nicht sichtbar — was KRNL meldet, ändert im Shop nichts Sichtbares' },
  { status: 'ARCHIVED', ton: 'neutral', text: 'für Kunden nicht sichtbar' },
  { status: null, ton: 'warn', text: 'der Shop-Stand dieses Angebots wurde noch nicht gelesen (läuft viertelstündlich)' },
]

const FILTER = [
  { wert: 'alle', text: 'Alle' },
  { wert: 'abweichung', text: 'Nur Abweichungen' },
  { wert: 'kaufbar', text: 'Nur was im Shop oder laut KRNL kaufbar ist' },
] as const

function passt(z: BestandZeile, zeige: string, q: string): boolean {
  if (zeige === 'abweichung' && (z.einordnung === 'gleich' || z.einordnung === 'unsichtbar')) return false
  if (zeige === 'kaufbar' && !z.shopKaufbar && z.krnl <= 0) return false
  if (!q) return true
  const text = `${z.produkt} ${z.variante} ${z.sku ?? ''} ${z.grund}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((wort) => text.includes(wort))
}

/**
 * Bestandsabgleich, vollständig (Entscheidungslog 2026-11-28): jede
 * Shop-Variante mit dem, was KRNL melden würde, und dem, was der Shop zeigt
 * — damit vor dem Scharfschalten zu sehen ist, was sich im Shop ändert.
 */
export default async function BestandsabgleichPage({
  searchParams,
}: {
  searchParams: Promise<{ zeige?: string; q?: string }>
}) {
  await requireArea('integrationen')
  const sp = await searchParams
  const zeige = FILTER.some((f) => f.wert === sp.zeige) ? sp.zeige! : 'alle'
  const q = (sp.q ?? '').trim()
  const [{ zeilen, gelesen }, mto, modus] = await Promise.all([bestandsliste(), madeToOrderEinstellung(), shopifyModus(sql)])

  const zahl = (e: Einordnung) => zeilen.filter((z) => z.einordnung === e).length
  const gezeigt = zeilen.filter((z) => passt(z, zeige, q))
  // Erst nach Shop-Status, darin nach Produkt.
  const bekannt = new Set(ABSCHNITTE.map((a) => a.status))
  const abschnitte = ABSCHNITTE.map((a) => {
    const gruppen = new Map<string, BestandZeile[]>()
    for (const z of gezeigt) {
      const status = bekannt.has(z.status) ? z.status : null
      if (status !== a.status) continue
      const schluessel = `${z.zweitangebot ? 'z' : 'v'}:${z.produkt}`
      gruppen.set(schluessel, [...(gruppen.get(schluessel) ?? []), z])
    }
    return { ...a, gruppen, zahl: [...gruppen.values()].reduce((n, g) => n + g.length, 0) }
  }).filter((a) => a.zahl > 0)
  const link = (wert: string) => {
    const p = new URLSearchParams()
    if (wert !== 'alle') p.set('zeige', wert)
    if (q) p.set('q', q)
    const s = p.toString()
    return `/integrationen/bestandsabgleich${s ? `?${s}` : ''}`
  }

  return (
    <>
      <PageHeader
        title="Bestandsabgleich — alle Shop-Varianten"
        subtitle="Was KRNL an Shopify melden würde, neben dem, was der Shop gerade zeigt."
        actions={
          <>
            <Link className="btn" href="/integrationen">Integrationen</Link>
            <Link className="btn" href="/verkauf/shop-verfuegbarkeit">Shop-Verfügbarkeit</Link>
          </>
        }
      />

      <div className={modus === 'schreiben' ? 'notice info' : 'notice warn'}>
        {mto.modus === 'fest'
          ? <>Tastaturen: <strong>feste Menge {qty(mto.deckel)}</strong>, solange mehr als {qty(mto.puffer)} baubar sind — sonst 0. </>
          : <>Tastaturen: <strong>aufgeteilt</strong> (Kontingent), Puffer {qty(mto.puffer)}, höchstens {qty(mto.deckel)}. </>}
        Lagerartikel: freier Bestand nach den Regeln am Artikel.{' '}
        {modus === 'schreiben'
          ? 'KRNL schreibt diese Mengen in den Shop.'
          : modus === 'probe'
            ? 'Probelauf: nichts geht an den Shop — die Spalte „KRNL meldet" zeigt, was nach dem Scharfschalten dort stünde.'
            : 'Nur lesen: nichts geht an den Shop.'}{' '}
        Shop-Stand zuletzt gelesen: {gelesen ? dateTime(gelesen) : 'noch nie'}.
      </div>

      <div className="grid-3" style={{ margin: '14px 0' }}>
        <Stat label="Shop-Angebote" value={qty(zeilen.length)} hint={`${qty(zahl('gleich'))} davon gleich`} />
        <Stat label="Gingen aus dem Verkauf" value={qty(zahl('nur_shop'))} hint="im Shop kaufbar, KRNL meldet 0" href={link('abweichung')} />
        <Stat label="Gingen in den Verkauf" value={qty(zahl('nur_krnl'))} hint="im Shop aus, KRNL meldet eine Menge" href={link('abweichung')} />
        <Stat label="Andere Menge" value={qty(zahl('menge'))} hint="Lagerartikel, bleibt kaufbar" href={link('abweichung')} />
      </div>

      <Card>
        <form method="get" className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          {zeige !== 'alle' && <input type="hidden" name="zeige" value={zeige} />}
          <label className="field" style={{ flex: 2 }}>
            <span>Suchen</span>
            <input id="bestandsabgleich-q" name="q" defaultValue={q} placeholder="Produkt, Variante, Artikelnummer, Engpass …" />
          </label>
          <div className="shrink field">
            <button type="submit">Suchen</button>
          </div>
          <div className="small" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingBottom: 8 }}>
            {FILTER.map((f) =>
              f.wert === zeige ? <strong key={f.wert}>{f.text}</strong> : <Link key={f.wert} href={link(f.wert)}>{f.text}</Link>,
            )}
          </div>
        </form>

        {gezeigt.length === 0 ? (
          <Empty>Keine Shop-Angebote für diese Auswahl.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Variante</th>
                  <th>Artikelnummer</th>
                  <th className="num">Shop zeigt</th>
                  <th className="num">KRNL meldet</th>
                  <th>Vergleich</th>
                  <th>Warum diese Menge</th>
                </tr>
              </thead>
              {abschnitte.map((abschnitt) => (
                <tbody key={abschnitt.status ?? 'unbekannt'}>
                  <tr>
                    <th colSpan={6} style={{ textAlign: 'left', paddingTop: 22 }}>
                      <span className={`badge ${abschnitt.ton}`}>
                        {abschnitt.status ? label('shop_produkt', abschnitt.status) : 'Status noch nicht gelesen'}
                      </span>{' '}
                      <span className="small muted">
                        {plural(abschnitt.zahl, 'Angebot', 'Angebote')} · {abschnitt.text}
                      </span>
                    </th>
                  </tr>
                  {[...abschnitt.gruppen.entries()].flatMap(([schluessel, gruppe]) => {
                    const erste = gruppe[0]
                    const abweichend = gruppe.filter((z) => z.einordnung !== 'gleich' && z.einordnung !== 'unsichtbar').length
                    return [
                      <tr key={schluessel}>
                        <th colSpan={6} style={{ textAlign: 'left', paddingTop: 12 }}>
                          {erste.zweitangebot ? (
                            <>{erste.produkt} <span className="small muted">— weiteres Shop-Angebot</span></>
                          ) : (
                            <Link href={`/produkte/${erste.template_id}`}>{erste.produkt}</Link>
                          )}{' '}
                          <span className="small muted">
                            · {erste.mto ? 'Tastatur (auf Bestellung gebaut)' : 'Lagerartikel'} · {plural(gruppe.length, 'Variante', 'Varianten')}
                            {abweichend > 0 ? ` · ${plural(abweichend, 'Abweichung', 'Abweichungen')}` : ''}
                          </span>
                        </th>
                      </tr>,
                      ...gruppe.map((z, i) => (
                        <tr key={`${schluessel}-${z.variant_id}-${i}`}>
                          <td>
                            <Link href={`/produkte/variante/${z.variant_id}?direkt=1`}>{z.variante || z.produkt}</Link>
                          </td>
                          <td className="mono small">{z.sku ?? '—'}</td>
                          <td className="num">
                            {z.shop === null ? '—' : qty(z.shop)}
                            {z.ohneBestand && <div className="small muted">verkauft ohne Bestand</div>}
                          </td>
                          <td className="num">{qty(z.krnl)}</td>
                          <td>
                            <span className={`badge ${TEXT[z.einordnung].ton}`} title={TEXT[z.einordnung].hinweis}>
                              {TEXT[z.einordnung].wort}
                            </span>
                          </td>
                          <td className="small">{z.grund}</td>
                        </tr>
                      )),
                    ]
                  })}
                </tbody>
              ))}
            </table>
          </TableWrap>
        )}
        <p className="small muted" style={{ margin: '12px 0 0' }}>
          {plural(gezeigt.length, 'Angebot', 'Angebote')} gezeigt von {qty(zeilen.length)}, gruppiert nach dem Status des
          Shop-Produkts (Aktiv, Nur per Link, Entwurf). Entwürfe zählen nie als Abweichung. Bei Tastaturen zählt nur kaufbar
          oder nicht — die feste Menge ist keine Bestandszahl. „Engpass" nennt das Teil, das als erstes ausgeht.
        </p>
      </Card>
    </>
  )
}
