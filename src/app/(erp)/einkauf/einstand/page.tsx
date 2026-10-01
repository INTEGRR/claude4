import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { FRACHT_MODI } from '@/modules/einkauf/einkaufsprojekt'
import { dateTime } from '@/modules/shared/format'
import { frachtsatzSetzen, zolltarifLoeschen, zolltarifSetzen } from '../projekte/actions'
import { einstandVorschlagUebernehmen } from '../sendungen/actions'

export const dynamic = 'force-dynamic'

const zahl = (n: string | number, stellen = 2) =>
  Number(n).toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: 4 })

/**
 * Einstand (0097): die Sätze hinter dem Angebotsvergleich — Fracht je kg
 * und Modus (mit Mindestbetrag je Sendung) und Zollsätze je HS-Präfix.
 * Startwerte der Fracht sind Schätzungen; seit Stufe 5 (0108) schlägt KRNL
 * aus abgerechneten Sendungen (K+N-Rechnungen, Zollbescheide) bessere Sätze
 * vor — übernommen wird per Knopf, nie still.
 */
export default async function EinstandPage() {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)

  const [fracht, zoll, vorschlaege] = await Promise.all([
    sql<{ modus: keyof typeof FRACHT_MODI; eur_je_kg: string; mindestbetrag_eur: string; notiz: string | null; geaendert_von: string | null; updated_at: string | null }[]>`
      select modus, eur_je_kg::text, mindestbetrag_eur::text, notiz, geaendert_von, updated_at::text as updated_at
      from frachtsaetze order by array_position(array['see', 'luft', 'express'], modus)`,
    sql<{ hs_praefix: string; satz_pct: string; bezeichnung: string | null; geaendert_von: string | null }[]>`
      select hs_praefix, satz_pct::text, bezeichnung, geaendert_von from zolltarife order by hs_praefix`,
    sql<{ art: 'fracht' | 'zoll'; schluessel: string; sendungen: number; ist_wert: number; soll_wert: number | null; eur_je_cbm: number | null; grundlage: string }[]>`
      select art, schluessel, sendungen, ist_wert::float as ist_wert, soll_wert::float as soll_wert,
             eur_je_cbm::float as eur_je_cbm, grundlage
      from einkauf_einstand_vorschlaege order by art, schluessel`,
  ])

  return (
    <>
      <PageHeader
        title="Einstand"
        subtitle="Fracht- und Zollsätze für den Angebotsvergleich — Einstand = Ware × Kurs + Werkzeug/Muster + Fracht + Zoll (ohne EUSt)"
      />

      {vorschlaege.length > 0 && (
        <Card title={`Gelernt aus abgerechneten Sendungen (${vorschlaege.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Satz</th>
                  <th className="num">Bisher</th>
                  <th className="num">Aus Sendungen</th>
                  <th>Grundlage</th>
                  {darf && <th />}
                </tr>
              </thead>
              <tbody>
                {vorschlaege.map((v) => (
                  <tr key={`${v.art}:${v.schluessel}`}>
                    <td>
                      {v.art === 'fracht' ? `Fracht ${FRACHT_MODI[v.schluessel as keyof typeof FRACHT_MODI] ?? v.schluessel}` : 'Zoll'}{' '}
                      {v.art === 'zoll' && <span className="mono">{v.schluessel}</span>}
                    </td>
                    <td className="num mono">
                      {v.soll_wert === null ? '—' : `${zahl(v.soll_wert, v.art === 'zoll' ? 1 : 2)}${v.art === 'zoll' ? ' %' : ' €/kg'}`}
                    </td>
                    <td className="num mono">
                      {zahl(v.ist_wert, v.art === 'zoll' ? 1 : 2)}
                      {v.art === 'zoll' ? ' %' : ' €/kg'}
                      {v.eur_je_cbm !== null && <div className="muted small">{zahl(v.eur_je_cbm)} €/cbm</div>}
                    </td>
                    <td className="small">{v.grundlage}</td>
                    {darf && (
                      <td>
                        <ActionButton className="small" action={einstandVorschlagUebernehmen.bind(null, v.art, v.schluessel)}>
                          Übernehmen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
            Fracht: echte Frachtkosten ÷ Bruttogewicht je Modus (€/cbm nur zur Info — die Positionen kennen kein Volumen);
            Zoll: Zoll ÷ Zollwert aus den Zollbescheiden je HS-Präfix. Vorgeschlagen wird ab 5 % bzw. 0,1 Prozentpunkten
            Abweichung.
          </p>
        </Card>
      )}

      <Card title="Frachtsätze" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Modus</th>
                <th className="num">€ je kg</th>
                <th className="num">Mindestbetrag je Sendung</th>
                <th>Notiz</th>
                {darf && <th />}
              </tr>
            </thead>
            <tbody>
              {fracht.map((f) => (
                <tr key={f.modus}>
                  <td>{FRACHT_MODI[f.modus]}</td>
                  <td className="num mono">{zahl(f.eur_je_kg)}</td>
                  <td className="num mono">{zahl(f.mindestbetrag_eur)} €</td>
                  <td className="small">
                    {f.notiz ?? '—'}
                    {f.geaendert_von && (
                      <div className="muted">
                        {f.geaendert_von}
                        {f.updated_at ? `, ${dateTime(f.updated_at)}` : ''}
                      </div>
                    )}
                  </td>
                  {darf && (
                    <td>
                      <details className="small">
                        <summary>Ändern</summary>
                        <ActionForm action={frachtsatzSetzen} style={{ marginTop: 6 }}>
                          <input type="hidden" name="modus" value={f.modus} />
                          <div className="row">
                            <label className="field">
                              <span>€ je kg</span>
                              <input name="eur_je_kg" inputMode="decimal" defaultValue={zahl(f.eur_je_kg)} required />
                            </label>
                            <label className="field">
                              <span>Mindestbetrag €</span>
                              <input name="mindestbetrag_eur" inputMode="decimal" defaultValue={zahl(f.mindestbetrag_eur)} />
                            </label>
                          </div>
                          <label className="field">
                            <span>Notiz</span>
                            <input name="notiz" defaultValue={f.notiz ?? ''} />
                          </label>
                          <button type="submit" className="small">
                            Speichern
                          </button>
                        </ActionForm>
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
          Die Fracht eines Angebots = Gewicht aller Positionen × Satz, mindestens der Mindestbetrag, verteilt nach Gewicht. Bei
          D-Klauseln (DAP, DPU, DDP) zahlt der Lieferant — dann keine Fracht. Ein Angebot kann „Fracht €/Stk" fest angeben.
        </p>
      </Card>

      <Card title={`Zollsätze (${zoll.length})`} tight>
        {zoll.length === 0 ? (
          <Empty>Noch keine Zollsätze. Ohne Satz zeigt der Vergleich „kein Zollsatz" statt still 0 % anzunehmen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>HS-Präfix</th>
                  <th className="num">Satz</th>
                  <th>Bezeichnung</th>
                  {darf && <th />}
                </tr>
              </thead>
              <tbody>
                {zoll.map((z) => (
                  <tr key={z.hs_praefix}>
                    <td className="mono">{z.hs_praefix}</td>
                    <td className="num mono">{zahl(z.satz_pct, 1)} %</td>
                    <td className="small">{z.bezeichnung ?? '—'}</td>
                    {darf && (
                      <td>
                        <ActionButton action={zolltarifLoeschen.bind(null, z.hs_praefix)} className="small" confirm={`Zollsatz ${z.hs_praefix} entfernen?`}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {darf && (
          <ActionForm action={zolltarifSetzen} style={{ padding: '10px 12px' }}>
            <div className="row">
              <label className="field">
                <span>HS-Präfix</span>
                <input name="hs_praefix" className="mono" required placeholder="z. B. 8473 oder 3926 90" />
              </label>
              <label className="field">
                <span>Satz %</span>
                <input name="satz_pct" inputMode="decimal" required placeholder="6,5" />
              </label>
              <label className="field">
                <span>Bezeichnung</span>
                <input name="bezeichnung" placeholder="z. B. Kunststoffwaren" />
              </label>
              <div className="shrink field">
                <button type="submit" className="primary">
                  Speichern
                </button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Der längste passende Präfix gewinnt (8473 30 vor 8473). Zollwert = Ware + Fracht; bei DDP kein Zoll. Die
              Einfuhrumsatzsteuer ist nie Teil des Einstands.
            </p>
          </ActionForm>
        )}
      </Card>
    </>
  )
}
