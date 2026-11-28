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
import { dateTime, plural, qty } from '@/modules/shared/format'
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
async function verkaufSchalten(templateIds: string[], start: boolean) {
  'use server'
  return serverAktion('verkauf.shop_verkauf_schalten', { parameter: { template_ids: templateIds, start } })
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

function teilText(t: TeilInfo): string {
  const regel = t.zurueck ? ' · für den Shop gesperrt' : t.oosUnter ? ` · aus unter ${qty(t.oosUnter)}` : ''
  return `${t.name}: ${qty(t.frei)} frei${regel}${t.je > 1 ? ` · ${qty(t.je)} je Stück` : ''} → reicht für ${qty(t.reicht)}`
}

/** Das knappste Teil einer Liste — der Engpass. */
function engpass(teile: TeilInfo[]): TeilInfo | null {
  return teile.reduce<TeilInfo | null>((min, t) => (min === null || t.reicht < min.reicht ? t : min), null)
}

/**
 * Ein Artikel, kompakt (2026-11-27): Einstellungen in einer Zeile, die
 * Optionen nebeneinander als dichte Zeilen — je Wert Zustand, Gewicht und
 * Sperre; Teile-Details stehen im Tooltip und nur beim Engpass im Text.
 */
function ArtikelAnsicht({
  a,
  projekt,
  darf,
  alleFarben,
  alleHref,
  geteilt,
}: {
  a: ArtikelInfo
  projekt: ProjektInfo
  darf: boolean
  alleFarben: boolean
  alleHref: string
  /** Teil → in wie vielen Artikeln es steckt (sein Bestand wird unter ihnen aufgeteilt). */
  geteilt: Map<string, number>
}) {
  const mehrereFarben = projekt.artikel.length > 1
  const knapp = engpass(a.gemeinsam)
  return (
    <>
      {darf && (
        <div className="shop-zeile">
          <ActionForm action={artikelSetzen}>
            <input type="hidden" name="template_id" value={a.id} />
            <span className="actions">
              <span className="small muted">an Shopify</span>
              <Auswahl name="modus" defaultValue={a.modus} className="small" aria-label={`${a.name} an Shopify`} style={{ width: 190 }}>
                {MODI.map((m) => (
                  <option key={m.wert} value={m.wert}>
                    {m.text}
                  </option>
                ))}
              </Auswahl>
              <span className="small muted">Shop-Projekt</span>
              <input name="projekt" defaultValue={a.projekt ?? ''} placeholder="z. B. NATIVE 75" aria-label="Shop-Projekt" style={{ width: 170 }} />
              <button type="submit" className="small">Speichern</button>
            </span>
          </ActionForm>
          <ActionForm action={gewichtSetzen}>
            <input type="hidden" name="template_id" value={a.id} />
            <span
              className="actions"
              title="Erwartete Nachfrage des Artikels. Knappe Teile werden nach Gewicht verteilt: Artikel × Optionswerte. Doppeltes Gewicht bekommt doppelt so viel; was sich gerade verkauft, bekommt von selbst mehr. Leer = 1."
            >
              <span className="small muted">Gewicht</span>
              <input name="gewicht" inputMode="decimal" defaultValue={a.gewicht ?? ''} placeholder="1" aria-label={`Gewicht ${a.name}`} style={{ width: 56 }} />
              <button type="submit" className="small">OK</button>
            </span>
          </ActionForm>
        </div>
      )}

      {a.gemeinsam.length > 0 && knapp && (
        <details className="shop-teile">
          <summary className="small">
            <span className="muted">In jeder Variante verbaut ({qty(a.gemeinsam.length)} Teile) — Engpass:</span> {knapp.name},{' '}
            <strong>reicht für {qty(knapp.reicht)}</strong>
            {(geteilt.get(knapp.id) ?? 1) > 1 && (
              <span className="muted"> · geteilt mit {plural((geteilt.get(knapp.id) ?? 1) - 1, 'weiterem Artikel', 'weiteren Artikeln')}</span>
            )}
          </summary>
          <div className="teil">
            Diese Teile stecken in jeder Variante von „{a.kurz}" — egal, was der Kunde wählt. „Reicht für" zählt
            Tastaturen. Steckt ein Teil auch in anderen Artikeln, teilen sie sich seinen Bestand.
          </div>
          {a.gemeinsam.map((t) => (
            <div key={t.id} className="teil">
              {teilText(t)}
              {(geteilt.get(t.id) ?? 1) > 1 && ` · auch in ${plural((geteilt.get(t.id) ?? 1) - 1, 'weiterem Artikel', 'weiteren Artikeln')}`}
            </div>
          ))}
        </details>
      )}

      {a.optionen.length > 0 && (
        <>
          {darf && mehrereFarben && (
            <div className="small muted" style={{ margin: '8px 0 4px' }}>
              Sperren und Gewichte gelten für:{' '}
              <Link href={alleHref} scroll={false} className="btn small" aria-current={alleFarben ? undefined : 'true'}>nur diese Farbe</Link>{' '}
              <Link href={`${alleHref}${alleHref.includes('?') ? '&' : '?'}alle=1`} scroll={false} className="btn small" aria-current={alleFarben ? 'true' : undefined}>alle Farben</Link>
            </div>
          )}
          <div className="shop-optionen">
            {a.optionen.map((o) => (
              <div key={o.name} className="shop-optionsspalte">
                <div className="mono-label">{o.name}</div>
                {o.werte.map((w) => {
                  const zustand = a.modus === 'aus' ? 'gesperrt' : w.gesperrt ? 'gesperrt' : w.aktiv > 0 ? 'aktiv' : 'leer'
                  const eng = engpass(w.teile)
                  const tipp = [
                    ...w.teile.map(teilText),
                    w.shopBekannt > 0
                      ? `im Shop jetzt: ${w.shopVerkaufbar === 0 ? 'ausverkauft' : `${qty(w.shopVerkaufbar)} von ${qty(w.shopBekannt)} verkaufbar`}`
                      : null,
                  ].filter(Boolean).join('\n')
                  return (
                    <div key={w.ptavId} className={`shop-wert ${zustand}`} title={tipp || undefined}>
                      <span className="shop-wert-name">{w.name}</span>
                      <span className="shop-wert-status">
                        {zustand === 'aktiv' ? (
                          <Zustand ton="ok">
                            bis {qty(w.maxSoll)}
                            {w.aktiv < w.varianten ? ` · ${qty(w.aktiv)}/${qty(w.varianten)}` : ''}
                          </Zustand>
                        ) : zustand === 'gesperrt' ? (
                          <Zustand ton="off">{w.gesperrt ? 'gesperrt' : 'Artikel aus'}</Zustand>
                        ) : (
                          <Zustand ton="warn">aus{eng ? ` · ${eng.name}` : ' · Material'}</Zustand>
                        )}
                      </span>
                      {darf && a.modus !== 'aus' && (
                        <span className="shop-wert-steuer">
                          {!w.gesperrt && (
                            <ActionForm action={gewichtSetzen}>
                              <input type="hidden" name="template_id" value={a.id} />
                              <input type="hidden" name="ptav_id" value={w.ptavId} />
                              {alleFarben && <input type="hidden" name="alle_farben" value="on" />}
                              <span className="actions" style={{ gap: 4 }}>
                                <input
                                  name="gewicht" inputMode="decimal" defaultValue={w.gewicht ?? ''} placeholder="1"
                                  aria-label={`Gewicht ${w.name}`} title="Erwartete Nachfrage (Gewicht) — leer = 1"
                                  style={{ width: 46 }}
                                />
                                <button type="submit" className="small" aria-label={`Gewicht ${w.name} speichern`}>OK</button>
                              </span>
                            </ActionForm>
                          )}
                          <ActionForm action={optionSetzen}>
                            <input type="hidden" name="template_id" value={a.id} />
                            <input type="hidden" name="ptav_id" value={w.ptavId} />
                            <input type="hidden" name="gesperrt" value={w.gesperrt ? 'false' : 'true'} />
                            {alleFarben && <input type="hidden" name="alle_farben" value="on" />}
                            <button type="submit" className={w.gesperrt ? 'small' : 'small danger'}>
                              {w.gesperrt ? 'Freigeben' : 'Sperren'}
                            </button>
                          </ActionForm>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}

      <details className="shop-teile">
        <summary className="small">
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
  /** „1" = Sperren und Gewichte der Optionswerte gelten für alle Farben des Projekts. */
  alle?: string
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
  // Teil → Anzahl Artikel, in denen es steckt: geteilte Teile begrenzen alle zusammen.
  const geteilt = new Map(daten.teile.map((t) => [t.id, t.artikel]))
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
        {mto.modus === 'fest' ? (
          <>
            <strong>Feste Menge:</strong> jede verfügbare Variante bekommt {mto.deckel} — ohne Aufteilung. Reicht
            ein Teil nur noch für {mto.puffer} Stück oder weniger (oder fällt es unter seine Schwelle „aus unter
            N"), gehen alle Varianten mit diesem Teil auf 0 — direkt mit der Bestellung, die es dorthin bringt.
            Shopify meldet eine Bestellung erst einige Sekunden nach dem Kauf; was in diesen Sekunden mit demselben
            Teil gekauft wird, ist überverkauft. Nach einem Verkauf wird nicht wieder aufgefüllt, die Zahl zählt
            herunter.
          </>
        ) : (
          <>
            <strong>Aufgeteilt:</strong> geteilte Teile werden als Kontingent auf die Angebote verteilt — die Summe
            übersteigt nie den freien Bestand. Deckel je Tastatur: baubar − {mto.puffer}, höchstens {mto.deckel}.
          </>
        )}{' '}
        (<Link href="/einstellungen/anbindungen">ändern</Link>).{' '}
        {modus === 'schreiben'
          ? 'Shopify ist scharf: jede Änderung hier geht sofort an den Shop.'
          : modus === 'probe'
            ? 'Probelauf: nichts geht an den Shop — was gemeldet würde, zeigt die Debug-Box unten rechts.'
            : 'Shopify steht auf „nur lesen" — hier lässt sich alles vorbereiten, gemeldet wird erst nach dem Umschalten.'}{' '}
        Shop-Stand zuletzt gelesen: {daten.zuletztGelesen ? dateTime(daten.zuletztGelesen) : 'noch nie'}.{' '}
        <Link href="/integrationen/bestandsabgleich">Alle Shop-Varianten in einer Liste</Link>
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
          <Card
            key={p.name}
            title={
              <>
                {p.name}{' '}
                <span className="small muted" style={{ fontWeight: 400 }}>
                  · {p.artikel.filter((x) => x.modus !== 'aus').length} von {p.artikel.length} im Verkauf
                </span>
              </>
            }
            actions={
              darf && (
                // Verkauf starten/stoppen für ALLE Artikel der Karte (Release per Knopfdruck).
                <>
                  <ActionButton
                    action={verkaufSchalten.bind(null, p.artikel.map((x) => x.id), true)}
                    className="small primary"
                    confirm={`Verkauf starten: ${p.artikel.length === 1 ? 'den Artikel' : `alle ${p.artikel.length} Artikel`} von „${p.name}" auf „berechnet" stellen? Die Regeln greifen, die Mengen gehen an Shopify.`}
                  >
                    Verkauf starten
                  </ActionButton>
                  <ActionButton
                    action={verkaufSchalten.bind(null, p.artikel.map((x) => x.id), false)}
                    className="small danger"
                    confirm={`Verkauf stoppen: ${p.artikel.length === 1 ? 'den Artikel' : `alle ${p.artikel.length} Artikel`} von „${p.name}" auf „aus" stellen? Shopify bekommt 0.`}
                  >
                    Verkauf stoppen
                  </ActionButton>
                </>
              )
            }
          >
            <div className="shop-pills">
              {p.artikel.map((a) => (
                <Link
                  key={a.id}
                  href={`${PFAD}?a=${a.id}${params.alle === '1' ? '&alle=1' : ''}`}
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
                          ? `${qty(a.aktiv)}/${qty(a.varianten.length)} · bis ${qty(a.maxSoll)}`
                          : 'ausverkauft'}
                  </span>
                </Link>
              ))}
            </div>
            <ArtikelAnsicht
              a={auswahl}
              projekt={p}
              darf={darf}
              alleFarben={params.alle === '1'}
              alleHref={`${PFAD}?a=${auswahl.id}`}
              geteilt={geteilt}
            />
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
              <strong>Nicht einzeln verkaufen</strong> (nur Shopartikel): der Artikel wird im Shop nicht einzeln
              angeboten; Tastaturen, die ihn brauchen, sind nicht betroffen. <strong>Für den Shop sperren:</strong>{' '}
              der Artikel zählt für den Shop als 0 — <strong>auch jede Tastatur, die ihn braucht, ist dann
              ausverkauft</strong> (an der Regel steht, wie viele es sind).{' '}
              <strong>Aus unter N:</strong> Notreserve — für den Shop zählt nur, was über N liegt, im Einzelverkauf
              und in Tastaturen. Nur bei Shopartikeln und nur für den Einzelverkauf: <strong>Rückhalt</strong> — so
              viele Stück bleiben der Fertigung; <strong>höchstens</strong> — nie mehr gleichzeitig im Shop anbieten.
              Alles wirkt sofort und nur für den Shop; die Fertigung sieht weiter den echten Bestand.
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
                        {z.nutzbar === null ? <span className="muted">—</span> : z.zurueck ? <Zustand ton="off">gesperrt</Zustand> : qty(z.nutzbar)}
                      </td>
                      <td className="num mono">
                        {!z.shop ? <span className="muted">—</span> : z.shop.nichtEinzeln ? <Zustand ton="off">nicht einzeln</Zustand> : z.shop.soll > 0 ? qty(z.shop.soll) : <Zustand ton="warn">0</Zustand>}
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
                              {z.shop && (
                                <label
                                  className="small"
                                  style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                                  title="Der Artikel wird im Shop nicht einzeln angeboten (Menge 0). Tastaturen, die ihn brauchen, sind nicht betroffen."
                                >
                                  <input type="hidden" name="nicht_einzeln_feld" value="1" />
                                  <input type="checkbox" name="nicht_einzeln" defaultChecked={z.shop.nichtEinzeln} /> nicht einzeln verkaufen
                                </label>
                              )}
                              <label
                                className="small"
                                style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                                title="Der Artikel zählt für den Shop als 0 — auch jede Tastatur, die ihn braucht, ist dann ausverkauft. Die Fertigung sieht weiter den echten Bestand."
                              >
                                <input type="checkbox" name="zurueckhalten" defaultChecked={z.zurueck} /> für den Shop sperren
                              </label>
                              {z.stuecklisten > 0 && (
                                <span className="small" role="note" style={{ color: 'var(--warn)' }}>
                                  Achtung: sperrt auch {plural(z.stuecklisten, 'Tastatur', 'Tastaturen')}
                                </span>
                              )}
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
