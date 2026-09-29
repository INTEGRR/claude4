'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { ActionResult } from '@/modules/shared/action'
import { Stat, TableWrap } from '@/components/ui'
import { money, qty } from '@/modules/shared/format'

interface Vorschau {
  uebersicht: Record<string, number>
  fertigprodukte: { code: string | null; name: string; status: string; grund?: string }[]
  blockiert: { was: string; grund: string }[]
  routen: { skus: string[]; fertigen: boolean; aufAuftrag: boolean }[]
  komponenten: {
    code: string | null
    name: string
    vorhanden: boolean
    uom: string | null
    preis: number | null
    bestand: number | null
    lieferanten: string[]
  }[]
  stuecklisten: { skus: string[]; jeVariante: boolean; zeilen: { komponente: string; menge: number; uom: string }[] }[]
}

/**
 * Vorschau laden → prüfen → übernehmen. Die Vorschau schreibt nichts; die
 * Übernahme liest Odoo erneut und schreibt alles in einer Transaktion.
 */
export function OdooUebernahme({
  vorschauLaden,
  uebernehmen,
}: {
  vorschauLaden: () => Promise<ActionResult>
  uebernehmen: () => Promise<ActionResult>
}) {
  const [pending, startTransition] = useTransition()
  const [vorschau, setVorschau] = useState<Vorschau | null>(null)
  const [meldung, setMeldung] = useState<{ ton: 'ok' | 'fehler'; text: string } | null>(null)
  const router = useRouter()

  const laden = () =>
    startTransition(async () => {
      setMeldung(null)
      const r = await vorschauLaden()
      if (r && 'error' in r) setMeldung({ ton: 'fehler', text: r.error })
      else if (r && 'daten' in r && r.daten) setVorschau(r.daten as unknown as Vorschau)
    })

  const ausfuehren = () => {
    if (!confirm('Stücklisten, Komponenten, Preise, Bestände und Routen jetzt aus Odoo übernehmen?')) return
    startTransition(async () => {
      const r = await uebernehmen()
      if (r && 'error' in r) setMeldung({ ton: 'fehler', text: r.error })
      else if (r && 'info' in r) {
        setMeldung({ ton: 'ok', text: r.info })
        setVorschau(null)
        router.refresh()
      }
    })
  }

  const u = vorschau?.uebersicht
  return (
    <div>
      <div className="actions" style={{ gap: 10 }}>
        <button type="button" onClick={laden} disabled={pending}>
          {pending && !vorschau ? 'Lese Odoo …' : 'Vorschau laden'}
        </button>
        {vorschau && (
          <button type="button" className="primary" onClick={ausfuehren} disabled={pending || !u?.stuecklisten}>
            {pending ? 'Übernehme …' : `${qty(u?.stuecklisten ?? 0)} Stückliste(n) übernehmen`}
          </button>
        )}
      </div>
      {meldung && (
        <div className={`notice ${meldung.ton === 'ok' ? 'info' : 'danger'}`} style={{ marginTop: 12 }}>
          {meldung.text}
        </div>
      )}

      {vorschau && u && (
        <>
          <div className="grid-3" style={{ margin: '14px 0' }}>
            <Stat
              label="Stücklisten"
              value={qty(u.stuecklisten)}
              hint={`${qty(u.vorlagenStuecklisten)} für ganze Artikel, der Rest je Variante`}
            />
            <Stat
              label="Fertigprodukte"
              value={`${qty(u.fertigZugeordnet)} zugeordnet`}
              hint={`${qty(u.fertigFehlt)} fehlen in KRNL (werden nicht angelegt) · ${qty(u.blockiert)} blockiert`}
            />
            <Stat
              label="Komponenten"
              value={`${qty(u.komponentenNeu)} neu`}
              hint={`${qty(u.komponentenVorhanden)} schon da · ${qty(u.komponentenOhneSku)} ohne SKU · ${qty(u.preise)} Preise · ${qty(u.bestand)} Bestände · ${qty(u.lieferantenpreise)} Lieferantenpreise`}
            />
          </div>

          {u.routen > 0 && (
            <div className="notice warn">
              Für {qty(u.routen)} Artikel werden die Routen aus Odoo eingeschaltet (Fertigen / Auf Auftrag). Ab dann
              erzeugt <strong>jede Shopify-Bestellung</strong> dieser Artikel einen Fertigungsauftrag in KRNL:{' '}
              <span className="mono small">
                {vorschau.routen.map((r) => `${r.skus.join('/')}${r.aufAuftrag ? ' (auf Auftrag)' : ''}`).join(', ')}
              </span>
            </div>
          )}

          {vorschau.blockiert.length > 0 && (
            <>
              <h3 className="mono-label" style={{ marginTop: 16 }}>Blockiert — wird nicht geschrieben</h3>
              <TableWrap>
                <table>
                  <tbody>
                    {vorschau.blockiert.map((b) => (
                      <tr key={`${b.was}-${b.grund}`}>
                        <td className="mono">{b.was}</td>
                        <td className="small">{b.grund}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          )}

          <h3 className="mono-label" style={{ marginTop: 16 }}>Stücklisten</h3>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Für</th>
                  <th>Komponenten je Stück</th>
                </tr>
              </thead>
              <tbody>
                {vorschau.stuecklisten.map((s) => (
                  <tr key={s.skus.join('|')}>
                    <td className="mono small">
                      {s.skus.join(', ')}
                      <div className="muted">{s.jeVariante ? 'je Variante' : 'ganzer Artikel'}</div>
                    </td>
                    <td className="small">
                      {s.zeilen.map((z) => `${qty(z.menge)} ${z.uom} ${z.komponente}`).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h3 className="mono-label" style={{ marginTop: 16 }}>Komponenten</h3>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>In KRNL</th>
                  <th className="num">Preis setzen</th>
                  <th className="num">Bestand setzen</th>
                  <th>Lieferanten</th>
                </tr>
              </thead>
              <tbody>
                {vorschau.komponenten.map((k) => (
                  <tr key={`${k.code}-${k.name}`}>
                    <td className="mono">{k.code ?? <span className="badge warn">ohne SKU</span>}</td>
                    <td>{k.name}</td>
                    <td className="small">{k.vorhanden ? 'schon da (bleibt)' : `neu (${k.uom})`}</td>
                    <td className="num mono">{k.preis === null ? '—' : money(k.preis)}</td>
                    <td className="num mono">{k.bestand === null ? '—' : qty(k.bestand)}</td>
                    <td className="small">{k.lieferanten.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          {vorschau.fertigprodukte.some((f) => f.status === 'fehlt') && (
            <p className="small muted">
              In KRNL nicht gefunden (keine Variante mit dieser SKU/diesem Barcode — wird nicht angelegt):{' '}
              <span className="mono">
                {vorschau.fertigprodukte.filter((f) => f.status === 'fehlt').map((f) => f.code ?? f.name).join(', ')}
              </span>
            </p>
          )}
        </>
      )}
    </div>
  )
}
