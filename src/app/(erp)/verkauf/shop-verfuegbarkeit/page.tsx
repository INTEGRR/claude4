import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, PageHeader, TableWrap, Zustand } from '@/components/ui'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { shopifyModus } from '@/modules/integrationen/shopify-modus'
import { madeToOrderEinstellung } from '@/modules/integrationen/made-to-order'
import {
  type ArtikelInfo,
  type Modus,
  type ProjektInfo,
  type TeilInfo,
  shopVerfuegbarkeit,
} from '@/modules/integrationen/shop-verfuegbarkeit'
import { dateTime, qty } from '@/modules/shared/format'

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
              <select name="modus" defaultValue={a.modus}>
                {MODI.map((m) => (
                  <option key={m.wert} value={m.wert}>
                    {m.text}
                  </option>
                ))}
              </select>
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
                    {v.name}
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
                          <select name="modus" defaultValue={v.modus ?? 'erben'} className="small" aria-label={`Steuerung ${v.name}`}>
                            <option value="erben">wie Artikel</option>
                            {MODI.map((m) => (
                              <option key={m.wert} value={m.wert}>
                                {m.text}
                              </option>
                            ))}
                          </select>
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
export default async function ShopVerfuegbarkeitPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const user = await requireArea('verkauf')
  const darf = canWrite(user.rollen, 'verkauf', user.befugnisse)
  const { a: gewaehlt } = await searchParams
  const [daten, mto, modus] = await Promise.all([shopVerfuegbarkeit(), madeToOrderEinstellung(), shopifyModus(sql)])

  return (
    <>
      <PageHeader
        title="Shop-Verfügbarkeit"
        subtitle="Was Shopify bekommt — Tastaturen aus dem Material berechnet, mit euren Regeln je Artikel, Option und Teil"
        actions={
          darf && (
            <ActionButton action={standHolen} className="small">
              Shop-Stand holen
            </ActionButton>
          )
        }
      />
      <div className={modus === 'schreiben' ? 'notice info' : 'notice warn'}>
        Meldung für Tastaturen:{' '}
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

      {daten.projekte.length === 0 && (
        <Card>
          <p className="small muted" style={{ margin: 0 }}>Keine Shopify-gekoppelten Made-to-Order-Artikel.</p>
        </Card>
      )}

      {daten.projekte.map((p) => {
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

      <Card title={`Teile-Regeln (${daten.teile.length})`} tight>
        <p className="small muted" style={{ margin: 0, padding: '10px 12px' }}>
          Schwelle „ausverkauft unter N": für den Shop zählt nur, was darüber liegt (Blue Cases unter 2 → alles mit
          Blue Case weg). Zurückhalten: zählt als 0 (z. B. Yellow Cases). Wirkt sofort auf jede Tastatur, die das Teil
          braucht — nur für den Shop, die Fertigung sieht weiter den echten Bestand.
        </p>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Teil</th>
                <th className="num">frei</th>
                <th className="num">für den Shop</th>
                <th className="num">Artikel</th>
                {darf && <th>Regel</th>}
              </tr>
            </thead>
            <tbody>
              {daten.teile.map((t) => (
                <tr key={t.id}>
                  <td className="small">
                    {t.name}
                    {t.sku && <span className="muted mono"> · {t.sku}</span>}
                  </td>
                  <td className="num mono">{qty(t.frei)}</td>
                  <td className="num mono">{t.zurueck ? <Zustand ton="off">zurück</Zustand> : qty(t.nutzbar)}</td>
                  <td className="num mono">{qty(t.artikel)}</td>
                  {darf && (
                    <td>
                      <ActionForm action={varianteSetzen}>
                        <input type="hidden" name="variant_id" value={t.id} />
                        <input type="hidden" name="zurueckhalten_feld" value="1" />
                        <div className="actions">
                          <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            aus unter
                            <input
                              name="oos_unter"
                              type="number"
                              min={1}
                              defaultValue={t.oosUnter ?? ''}
                              style={{ width: 70 }}
                              aria-label={`Schwelle ${t.name}`}
                            />
                          </label>
                          <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <input type="checkbox" name="zurueckhalten" defaultChecked={t.zurueck} /> zurückhalten
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
      </Card>

      <Card title={`Weitere Shop-Artikel (${daten.weitere.length})`} tight>
        <details>
          <summary className="small" style={{ cursor: 'pointer', padding: '10px 12px' }}>
            Lagerware (Zubehör, Switches, Deskmats …): freier Bestand mit denselben Regeln — aufklappen
          </summary>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th className="num">frei</th>
                  <th className="num">an Shopify</th>
                  <th className="num">im Shop jetzt</th>
                  {darf && <th>Steuerung</th>}
                </tr>
              </thead>
              <tbody>
                {daten.weitere.map((w) => (
                  <tr key={w.id}>
                    <td className="small">
                      {w.name}
                      {w.sku && <span className="muted mono"> · {w.sku}</span>}
                    </td>
                    <td className="num mono">{qty(w.frei)}</td>
                    <td className="num mono">{w.soll > 0 ? qty(w.soll) : <Zustand ton="warn">0</Zustand>}</td>
                    <td className="num mono">
                      {w.shopVerkaufbar === null ? '—' : w.shopVerkaufbar ? qty(w.shopQty ?? 0) : 'aus'}
                    </td>
                    {darf && (
                      <td>
                        <ActionForm action={varianteSetzen}>
                          <input type="hidden" name="variant_id" value={w.id} />
                          <input type="hidden" name="zurueckhalten_feld" value="1" />
                          <div className="actions">
                            <select name="modus" defaultValue={w.modus ?? 'erben'} className="small" aria-label={`Steuerung ${w.name}`}>
                              <option value="erben">wie Artikel ({MODI.find((m) => m.wert === w.artikelModus)?.text})</option>
                              {MODI.map((m) => (
                                <option key={m.wert} value={m.wert}>
                                  {m.text}
                                </option>
                              ))}
                            </select>
                            <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              aus unter
                              <input name="oos_unter" type="number" min={1} defaultValue={w.oosUnter ?? ''} style={{ width: 70 }} />
                            </label>
                            <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              <input type="checkbox" name="zurueckhalten" defaultChecked={w.zurueck} /> zurück
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
        </details>
      </Card>
    </>
  )
}
