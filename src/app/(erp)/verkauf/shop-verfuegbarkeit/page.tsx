import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap, Zustand } from '@/components/ui'
import { GroesseBehalten, Seiten } from '@/components/seiten'
import { seitenHref, seitenParameter } from '@/modules/shared/seiten'
import { artikelListe, jaNein, listeFiltern } from '@/modules/integrationen/shop-artikel-liste'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { shopifyModus } from '@/modules/integrationen/shopify-modus'
import { madeToOrderEinstellung } from '@/modules/integrationen/made-to-order'
import { notAusAktiv } from '@/modules/integrationen/inventar'
import { shopProdukteMitLuecken } from '@/modules/integrationen/shop-anlage'
import {
  type ArtikelInfo,
  type Modus,
  type ProjektInfo,
  type TeilInfo,
  shopVerfuegbarkeit,
} from '@/modules/integrationen/shop-verfuegbarkeit'
import { dateTime, qty } from '@/modules/shared/format'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

async function artikelSetzen(formData: FormData) {
  'use server'
  return serverAktion('verkauf.shop_artikel_setzen', { formData })
}
async function varianteSetzen(formData: FormData) {
  'use server'
  return serverAktion('verkauf.shop_variante_setzen', { formData })
}
async function optionSetzen(formData: FormData) {
  'use server'
  return serverAktion('verkauf.shop_option_setzen', { formData })
}
async function standHolen() {
  'use server'
  return serverAktion('verkauf.shop_stand_holen', {})
}
async function zweitangebotSetzen(formData: FormData) {
  'use server'
  return serverAktion('verkauf.shop_zweitangebot_setzen', { formData })
}
async function gewichtSetzen(formData: FormData) {
  'use server'
  return serverAktion('verkauf.shop_gewicht_setzen', { formData })
}
async function notAusAn() {
  'use server'
  return serverAktion('verkauf.shop_not_aus', { parameter: { aktiv: true } })
}
async function notAusAb() {
  'use server'
  return serverAktion('verkauf.shop_not_aus', { parameter: { aktiv: false } })
}

const MODI: { wert: Modus; text: string }[] = [
  { wert: 'auto', text: 'berechnet' },
  { wert: 'immer', text: 'immer verfügbar' },
  { wert: 'aus', text: 'aus (ausverkauft)' },
]

function Teilzeile({ t }: { t: TeilInfo }) {
  const regel = t.zurueck ? ' · zurückgehalten' : t.oosUnter ? ` · aus unter ${qty(t.oosUnter)}` : ''
  return (
    <div className="teil">
      {t.name}: {qty(t.frei)} frei{regel}
      {t.je > 1 ? ` · ${qty(t.je)} je Stück` : ''} → <strong>reicht für {qty(t.reicht)}</strong>
    </div>
  )
}

function ShopIst({ verkaufbar, bekannt }: { verkaufbar: number; bekannt: number }) {
  if (bekannt === 0) return null
  return (
    <div className="teil">
      im Shop jetzt: {verkaufbar === 0 ? 'ausverkauft' : `${qty(verkaufbar)} von ${qty(bekannt)} verkaufbar`}
    </div>
  )
}

function ArtikelAnsicht({ a, projekt, darf }: { a: ArtikelInfo; projekt: ProjektInfo; darf: boolean }) {
  const mehrereFarben = projekt.artikel.length > 1
  return (
    <>
      {darf && (
        <ActionForm action={artikelSetzen}>
          <input type="hidden" name="template_id" value={a.id} />
          <div className="row">
            <label className="field">
              <span>{a.name} — an Shopify</span>
              <Auswahl name="modus" defaultValue={a.modus}>
                {MODI.map((m) => (
                  <option key={m.wert} value={m.wert}>
                    {m.text}
                  </option>
                ))}
              </Auswahl>
            </label>
            <label className="field">
              <span>Shop-Projekt (Farb-Pills)</span>
              <input name="projekt" defaultValue={a.projekt ?? ''} placeholder="z. B. NATIVE 75" />
            </label>
            <div className="shrink field">
              <button type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
      )}
      {darf && (
        <ActionForm action={gewichtSetzen}>
          <input type="hidden" name="template_id" value={a.id} />
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Erwartete Nachfrage des Artikels (Gewicht)</span>
              <input name="gewicht" inputMode="decimal" defaultValue={a.gewicht ?? ''} placeholder="1" />
            </label>
            <div className="shrink field">
              <button type="submit" className="small">Gewicht setzen</button>
            </div>
            <p className="muted small" style={{ margin: '0 0 6px', flex: 1 }}>
              Knappe Teile werden nach Gewicht auf die Varianten verteilt: Artikel × Optionswerte. Doppeltes Gewicht
              bekommt doppelt so viel; was sich gerade verkauft, bekommt von selbst mehr.
            </p>
          </div>
        </ActionForm>
      )}

      {a.gemeinsam.length > 0 && (
        <div className="shop-option">
          <div className="mono-label">Gemeinsame Teile (jede Variante)</div>
          {a.gemeinsam.slice(0, 4).map((t) => (
            <Teilzeile key={t.id} t={t} />
          ))}
          {a.gemeinsam.length > 4 && <div className="teil">… und {qty(a.gemeinsam.length - 4)} weitere mit mehr Bestand</div>}
        </div>
      )}

      {a.optionen.map((o) => (
        <div key={o.name} className="shop-option">
          <div className="mono-label">{o.name}</div>
          <div className="shop-chips">
            {o.werte.map((w) => {
              const zustand = a.modus === 'aus' ? 'gesperrt' : w.gesperrt ? 'gesperrt' : w.aktiv > 0 ? 'aktiv' : 'leer'
              return (
                <div key={w.ptavId} className={`shop-chip ${zustand}`}>
                  <span className="wert">{w.name}</span>
                  <div className="status">
                    {zustand === 'aktiv' ? (
                      <Zustand ton="ok">
                        aktiv · bis {qty(w.maxSoll)}
                        {w.aktiv < w.varianten ? ` · ${qty(w.aktiv)}/${qty(w.varianten)}` : ''}
                      </Zustand>
                    ) : zustand === 'gesperrt' ? (
                      <Zustand ton="off">{w.gesperrt ? 'gesperrt' : 'Artikel aus'}</Zustand>
                    ) : (
                      <Zustand ton="warn">ausverkauft · Material</Zustand>
                    )}
                  </div>
                  {w.teile.map((t) => (
                    <Teilzeile key={t.id} t={t} />
                  ))}
                  <ShopIst verkaufbar={w.shopVerkaufbar} bekannt={w.shopBekannt} />
                  {darf && a.modus !== 'aus' && (
                    <ActionForm action={optionSetzen}>
                      <input type="hidden" name="template_id" value={a.id} />
                      <input type="hidden" name="ptav_id" value={w.ptavId} />
                      <input type="hidden" name="gesperrt" value={w.gesperrt ? 'false' : 'true'} />
                      <div className="actions" style={{ marginTop: 6 }}>
                        <button type="submit" className={w.gesperrt ? 'small' : 'small danger'}>
                          {w.gesperrt ? 'Freigeben' : 'Deaktivieren'}
                        </button>
                        {mehrereFarben && (
                          <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <input type="checkbox" name="alle_farben" /> alle Farben
                          </label>
                        )}
                      </div>
                    </ActionForm>
                  )}
                  {darf && a.modus !== 'aus' && !w.gesperrt && (
                    <ActionForm action={gewichtSetzen}>
                      <input type="hidden" name="template_id" value={a.id} />
                      <input type="hidden" name="ptav_id" value={w.ptavId} />
                      <div className="actions" style={{ marginTop: 6, alignItems: 'center' }}>
                        <input
                          name="gewicht" inputMode="decimal" defaultValue={w.gewicht ?? ''} placeholder="1"
                          aria-label={`Gewicht ${w.name}`} title="Erwartete Nachfrage (Gewicht) — leer = 1"
                          style={{ width: 64 }}
                        />
                        <button type="submit" className="small">Gewicht</button>
                        {mehrereFarben && (
                          <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <input type="checkbox" name="alle_farben" /> alle Farben
                          </label>
                        )}
                      </div>
                    </ActionForm>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <details className="shop-option">
        <summary className="small" style={{ cursor: 'pointer' }}>
          Varianten einzeln ({qty(a.aktiv)} von {qty(a.varianten.length)} aktiv)
        </summary>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Variante</th>
                <th className="num">baubar</th>
                <th>Engpass</th>
                <th className="num">an Shopify</th>
                <th className="num">im Shop jetzt</th>
                {darf && <th>Steuerung</th>}
              </tr>
            </thead>
            <tbody>
              {a.varianten.map((v) => (
                <tr key={v.id}>
                  <td className="small">
                    <Link href={`/produkte/variante/${v.id}`}>{v.name}</Link>
                    {v.sku && <span className="muted mono"> · {v.sku}</span>}
                  </td>
                  <td className="num mono">{qty(v.baubar)}</td>
                  <td className="small">{v.engpass ?? '—'}</td>
                  <td className="num mono">{v.soll > 0 ? qty(v.soll) : <Zustand ton="warn">0</Zustand>}</td>
                  <td className="num mono">
                    {v.shopVerkaufbar === null ? '—' : v.shopVerkaufbar ? qty(v.shopQty ?? 0) : 'aus'}
                  </td>
                  {darf && (
                    <td>
                      <ActionForm action={varianteSetzen}>
                        <input type="hidden" name="variant_id" value={v.id} />
                        <div className="actions">
                          <Auswahl name="modus" defaultValue={v.modus ?? 'erben'} className="small" aria-label={`Steuerung ${v.name}`}>
                            <option value="erben">wie Artikel</option>
                            {MODI.map((m) => (
                              <option key={m.wert} value={m.wert}>
                                {m.text}
                              </option>
                            ))}
                          </Auswahl>
                          <button type="submit" className="small">
                            OK
                          </button>
                        </div>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
    </>
  )
}

/**
 * Shop-Verfügbarkeit (0101): je Shop-Projekt die Farb-Artikel wie im Shop
 * (eigene Shopify-Produkte), darunter die Optionen als Chips mit den Teilen
 * und ihrem Bestand, was an Shopify geht und was der Shop gerade zeigt —
 * plus die Regeln: Artikel/Variante auto·immer·aus, Option deaktivieren,
 * Teil mit Schwelle oder zurückgehalten.
 */
type Ansicht = 'tastaturen' | 'artikel' | 'zweit'
type Parameter = {
  a?: string
  ansicht?: string
  stl?: string
  shop?: string
  q?: string
  seite?: string
  pro?: string
}
const PFAD = '/verkauf/shop-verfuegbarkeit'

/** Link in der Ansicht „Teile und Artikel" mit geändertem Filter — Suche und Seitengröße bleiben, zurück auf Seite 1. */
function filterHref(params: Parameter, name: 'stl' | 'shop', wert: 'ja' | 'nein' | null): string {
  return seitenHref(PFAD, { ...params, ansicht: 'artikel', [name]: wert ?? undefined, seite: undefined }, 1)
}

export default async function ShopVerfuegbarkeitPage({ searchParams }: { searchParams: Promise<Parameter> }) {
  const user = await requireArea('verkauf')
  const darf = canWrite(user.rollen, 'verkauf', user.befugnisse)
  const params = await searchParams
  const gewaehlt = params.a
  const ansicht: Ansicht = params.ansicht === 'artikel' || params.ansicht === 'zweit' ? params.ansicht : 'tastaturen'
  const [daten, mto, modus, notAus, unvollstaendig] = await Promise.all([
    shopVerfuegbarkeit(), madeToOrderEinstellung(), shopifyModus(sql), notAusAktiv(), shopProdukteMitLuecken(),
  ])

  // Eine Liste statt zweier Karten: Stücklistenteile und Shop-Artikel zusammen, gefiltert, gesucht, geblättert.
  const alle = artikelListe(daten.teile, daten.weitere)
  const stl = jaNein(params.stl)
  const shop = jaNein(params.shop)
  const q = (params.q ?? '').trim()
  const gefiltert = listeFiltern(alle, { stueckliste: stl, shop, q })
  const seite = seitenParameter(params)
  const zeilen = gefiltert.slice(seite.offset, seite.offset + seite.limit)

  return (
    <>
      <PageHeader
        title="Shop-Verfügbarkeit"
        subtitle="Was Shopify bekommt — Tastaturen aus dem Material berechnet, mit euren Regeln je Artikel, Option und Teil"
        actions={
          darf && (
            <>
              <ActionButton action={standHolen} className="small">
                Shop-Stand holen
              </ActionButton>
              {notAus ? (
                <ActionButton action={notAusAb} className="small" confirm="Not-Aus aufheben? Die Kontingente werden neu verteilt und an den Shop gemeldet.">
                  Not-Aus aufheben
                </ActionButton>
              ) : (
                <ActionButton action={notAusAn} className="small danger" confirm="Not-Aus: ALLE Angebote im Shop sofort auf ausverkauft setzen?">
                  Not-Aus
                </ActionButton>
              )}
            </>
          )
        }
      />
      {notAus && (
        <div className="notice danger">
          <span className="led warn" /> <strong>Not-Aus aktiv:</strong> alle Angebote stehen im Shop auf ausverkauft.
          Bestellungen, die schon eingegangen sind, laufen normal weiter. Aufheben verteilt die Kontingente neu.
        </div>
      )}
      {unvollstaendig.length > 0 && (
        <details className="notice warn">
          <summary style={{ cursor: 'pointer' }}>
            <span className="led warn" />{' '}
            <strong>
              {unvollstaendig.length === 1
                ? '1 Shop-Produkt ist unvollständig angelegt'
                : `${unvollstaendig.length} Shop-Produkte sind unvollständig angelegt`}
            </strong>{' '}
            — ohne Route oder Stückliste wird aus der Bestellung kein Auftrag.
          </summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {unvollstaendig.map((p) => (
              <li key={p.id}>
                <Link href={`/produkte/${p.id}`}>{p.name}</Link>: {p.luecken.map((l) => l.text).join(' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className={modus === 'schreiben' ? 'notice info' : 'notice warn'}>
        Geteilte Teile werden als Kontingent auf die Angebote verteilt — die Summe übersteigt nie den freien
        Bestand. Deckel je Tastatur:{' '}
        {mto.modus === 'fest'
          ? `${mto.deckel}, solange mehr als ${mto.puffer} baubar`
          : `baubar − ${mto.puffer}, höchstens ${mto.deckel}`}{' '}
        (<Link href="/einstellungen/anbindungen">ändern</Link>).{' '}
        {modus === 'schreiben'
          ? 'Shopify ist scharf: jede Änderung hier geht sofort an den Shop.'
          : modus === 'probe'
            ? 'Probelauf: nichts geht an den Shop — was gemeldet würde, zeigt die Debug-Box unten rechts.'
            : 'Shopify steht auf „nur lesen" — hier lässt sich alles vorbereiten, gemeldet wird erst nach dem Umschalten.'}{' '}
        Shop-Stand zuletzt gelesen: {daten.zuletztGelesen ? dateTime(daten.zuletztGelesen) : 'noch nie'}.
      </div>

      <div className="actions" style={{ margin: '0 0 12px' }} role="navigation" aria-label="Ansicht">
        {(
          [
            ['tastaturen', 'Tastaturen', daten.projekte.reduce((n, p) => n + p.artikel.length, 0)],
            ['artikel', 'Teile und Artikel', alle.length],
            ['zweit', 'Zweitangebote', daten.zweitangebote.length],
          ] as const
        ).map(([key, label, zahl]) => (
          <Link
            key={key}
            href={key === 'tastaturen' ? PFAD : `${PFAD}?ansicht=${key}`}
            className="btn small"
            aria-current={ansicht === key ? 'page' : undefined}
          >
            {label} <span className="filter-zahl">{zahl}</span>
          </Link>
        ))}
      </div>

      {ansicht === 'tastaturen' && daten.projekte.length === 0 && (
        <Card>
          <p className="small muted" style={{ margin: 0 }}>Keine Shopify-gekoppelten Made-to-Order-Artikel.</p>
        </Card>
      )}

      {ansicht === 'tastaturen' && daten.projekte.map((p) => {
        const auswahl = p.artikel.find((a) => a.id === gewaehlt) ?? p.artikel[0]
        return (
          <Card key={p.name} title={p.name}>
            <div className="mono-label">{p.artikel.length > 1 ? 'Gehäusefarbe (je ein Shopify-Produkt)' : 'Artikel'}</div>
            <div className="shop-pills">
              {p.artikel.map((a) => (
                <Link
                  key={a.id}
                  href={`/verkauf/shop-verfuegbarkeit?a=${a.id}`}
                  scroll={false}
                  className={`shop-pill ${a.modus === 'aus' ? 'gesperrt' : a.aktiv > 0 ? 'aktiv' : 'leer'}`}
                  aria-current={a.id === auswahl.id ? 'page' : undefined}
                >
                  <span>{a.kurz}</span>
                  <span className="klein">
                    {a.modus === 'aus'
                      ? 'aus'
                      : a.modus === 'immer'
                        ? 'immer verfügbar'
                        : a.aktiv > 0
                          ? `aktiv · ${qty(a.aktiv)}/${qty(a.varianten.length)} · bis ${qty(a.maxSoll)}`
                          : 'ausverkauft'}
                  </span>
                </Link>
              ))}
            </div>
            <ArtikelAnsicht a={auswahl} projekt={p} darf={darf} />
          </Card>
        )
      })}

      {ansicht === 'artikel' && (
        <Card tight>
          <div className="actions" style={{ padding: 12, rowGap: 8 }}>
            <span className="mono-label">Stücklistenartikel</span>
            {([[null, 'alle'], ['ja', 'ja'], ['nein', 'nein']] as const).map(([wert, label]) => (
              <Link key={`stl-${label}`} href={filterHref(params, 'stl', wert)} className="btn small" aria-current={stl === wert ? 'true' : undefined}>
                {label}
              </Link>
            ))}
            <span className="mono-label" style={{ marginLeft: 12 }}>Shopartikel</span>
            {([[null, 'alle'], ['ja', 'ja'], ['nein', 'nein']] as const).map(([wert, label]) => (
              <Link key={`shop-${label}`} href={filterHref(params, 'shop', wert)} className="btn small" aria-current={shop === wert ? 'true' : undefined}>
                {label}
              </Link>
            ))}
            <form className="actions" style={{ marginLeft: 'auto', gap: 6 }}>
              <input type="hidden" name="ansicht" value="artikel" />
              {stl && <input type="hidden" name="stl" value={stl} />}
              {shop && <input type="hidden" name="shop" value={shop} />}
              <GroesseBehalten params={params} />
              <input
                type="search"
                name="q"
                aria-label="Suche nach Name oder Artikelnummer"
                placeholder="Name oder Artikelnummer"
                defaultValue={q}
                style={{ width: 240 }}
              />
              <button type="submit" className="small">Suchen</button>
            </form>
          </div>
          <details style={{ padding: '0 12px 10px' }}>
            <summary className="small muted" style={{ cursor: 'pointer' }}>Was bedeuten die Regeln?</summary>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              <strong>Aus unter N:</strong> für den Shop zählt nur, was darüber liegt (Blue Cases unter 2 → alles mit
              Blue Case weg). <strong>Zurückhalten:</strong> zählt für den Shop als 0. Beides wirkt sofort auf jede
              Tastatur, die das Teil braucht — nur für den Shop, die Fertigung sieht weiter den echten Bestand.
              Nur bei Shopartikeln: <strong>Rückhalt</strong> — so viele Stück bleiben der Fertigung, einzeln
              verkaufbar ist nur, was darüber liegt; <strong>höchstens</strong> — nie mehr gleichzeitig im Shop
              anbieten. Beides gilt nur für den Einzelverkauf.
            </p>
          </details>
          {zeilen.length === 0 ? (
            <Empty>Keine Artikel für diese Auswahl.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th className="num">frei</th>
                    <th className="num">in Tastaturen</th>
                    <th className="num">für Tastaturen</th>
                    <th className="num">an Shopify</th>
                    <th className="num">im Shop jetzt</th>
                    {darf && <th>Regel</th>}
                  </tr>
                </thead>
                <tbody>
                  {zeilen.map((z) => (
                    <tr key={z.id}>
                      <td className="small">
                        <Link href={`/produkte/variante/${z.id}`}>{z.name}</Link>
                        {z.sku && <span className="muted mono nowrap"> · {z.sku}</span>}
                      </td>
                      <td className="num mono">{qty(z.frei)}</td>
                      <td className="num mono">{z.stuecklisten > 0 ? qty(z.stuecklisten) : <span className="muted">—</span>}</td>
                      <td className="num mono">
                        {z.nutzbar === null ? <span className="muted">—</span> : z.zurueck ? <Zustand ton="off">zurück</Zustand> : qty(z.nutzbar)}
                      </td>
                      <td className="num mono">
                        {!z.shop ? <span className="muted">—</span> : z.shop.soll > 0 ? qty(z.shop.soll) : <Zustand ton="warn">0</Zustand>}
                      </td>
                      <td className="num mono">
                        {!z.shop || z.shop.shopVerkaufbar === null ? <span className="muted">—</span> : z.shop.shopVerkaufbar ? qty(z.shop.shopQty ?? 0) : 'aus'}
                      </td>
                      {darf && (
                        <td>
                          <ActionForm action={varianteSetzen}>
                            <input type="hidden" name="variant_id" value={z.id} />
                            <input type="hidden" name="zurueckhalten_feld" value="1" />
                            <div className="actions">
                              {z.shop && (
                                <Auswahl name="modus" defaultValue={z.shop.modus ?? 'erben'} className="small" aria-label={`Steuerung ${z.name}`}>
                                  <option value="erben">wie Artikel ({MODI.find((m) => m.wert === z.shop?.artikelModus)?.text})</option>
                                  {MODI.map((m) => (
                                    <option key={m.wert} value={m.wert}>
                                      {m.text}
                                    </option>
                                  ))}
                                </Auswahl>
                              )}
                              <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                aus unter
                                <input name="oos_unter" type="number" min={1} defaultValue={z.oosUnter ?? ''} style={{ width: 70 }} aria-label={`Schwelle ${z.name}`} />
                              </label>
                              {z.shop && (
                                <>
                                  <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                    Rückhalt
                                    <input name="rueckhalt" type="number" min={0} step="1" defaultValue={z.shop.rueckhalt ?? ''} style={{ width: 70 }} />
                                  </label>
                                  <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                    höchstens
                                    <input name="hoechstmenge" type="number" min={0} step="1" defaultValue={z.shop.hoechstmenge ?? ''} style={{ width: 70 }} />
                                  </label>
                                </>
                              )}
                              <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                <input type="checkbox" name="zurueckhalten" defaultChecked={z.zurueck} /> zurückhalten
                              </label>
                              <button type="submit" className="small">
                                OK
                              </button>
                            </div>
                          </ActionForm>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          <Seiten pfad={PFAD} params={params} seite={seite} gesamt={gefiltert.length} />
        </Card>
      )}

      {ansicht === 'zweit' && (
        <Card title={`Zweitangebote (${daten.zweitangebote.length})`} tight>
          <p className="small muted" style={{ margin: 0, padding: '10px 12px' }}>
            Weitere Shop-Angebote mit der SKU eines Artikels — die Bestandteil-Liste eines Bundles (z. B. „Black Week
            Editions") oder eine Aktions-Edition. Sie bekommen dieselbe Menge wie der Artikel; die Bundles-App rechnet
            daraus die Bundle-Verfügbarkeit. „aus" meldet nur diesem Angebot 0, der Artikel läuft normal weiter. Gefunden
            werden sie beim Produktimport und bei „Shop-Stand holen".
          </p>
          {daten.zweitangebote.length > 0 && (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Shop-Angebot</th>
                    <th>Artikel</th>
                    <th className="num">an Shopify</th>
                    <th className="num">zuletzt gemeldet</th>
                    <th className="num">im Shop jetzt</th>
                    {darf && <th>Steuerung</th>}
                  </tr>
                </thead>
                <tbody>
                  {daten.zweitangebote.map((z) => (
                    <tr key={z.id}>
                      <td className="small">
                        {z.produkt ?? '—'}
                        {z.sku && <span className="muted mono"> · {z.sku}</span>}
                        {z.fehler && (
                          <div className="small" style={{ color: 'var(--danger)' }}>
                            Shopify lehnt ab: {z.fehler}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <Link href={`/produkte/variante/${z.variantId}`}>{z.artikel}</Link>
                      </td>
                      <td className="num mono">{z.soll > 0 ? qty(z.soll) : <Zustand ton="warn">0</Zustand>}</td>
                      <td className="num mono">{z.gemeldet === null ? '—' : qty(z.gemeldet)}</td>
                      <td className="num mono">
                        {z.shopVerkaufbar === null ? '—' : z.shopVerkaufbar ? qty(z.shopQty ?? 0) : 'aus'}
                      </td>
                      {darf && (
                        <td>
                          <ActionForm action={zweitangebotSetzen}>
                            <input type="hidden" name="angebot_id" value={z.id} />
                            <div className="actions">
                              <Auswahl
                                name="modus"
                                defaultValue={z.modus}
                                className="small"
                                aria-label={`Steuerung ${z.produkt ?? z.artikel}`}
                              >
                                <option value="auto">wie der Artikel</option>
                                <option value="immer">immer verfügbar</option>
                                <option value="aus">aus (ausverkauft)</option>
                              </Auswahl>
                              <button type="submit" className="small">
                                OK
                              </button>
                            </div>
                          </ActionForm>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  )
}
