import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { DRUCKFORMATE } from '@/modules/einstellungen/finanz-parameter'
import { dateTime, money } from '@/modules/shared/format'
import { druckbrueckeKonfig } from '@/modules/versand/druckbruecke'
import { arbeitsplatzIdDesGeraets } from '@/modules/druck/arbeitsplatz'
import {
  ARBEITSPLATZ_ART_LABELS,
  ARBEITSPLATZ_ARTEN,
  type ArbeitsplatzArt,
  DRUCKART_LABELS,
  DRUCKART_TYP,
  DRUCKARTEN,
  type Druckart,
} from '@/modules/druck/routing'
import { DruckwegWahl } from './druckweg-wahl'

export const dynamic = 'force-dynamic'

/** Der Agent fragt alle paar Sekunden — nach zwei Minuten Stille gilt er als weg. */
const AGENT_LEBT_MINUTEN = 2

interface Platz {
  id: string
  code: string
  name: string
  art: ArbeitsplatzArt
  cost_per_hour: number
  capacity: number
  time_efficiency: number
  active: boolean
  note: string | null
}

interface Drucker {
  id: string
  name: string
  work_center_id: string | null
  ort: string | null
  druckername: string | null
  typ: 'label' | 'a4'
  breite_mm: string | null
  hoehe_mm: string | null
  dhl_format: string | null
  aktiv: boolean
  zuletzt_gesehen: string | null
  offen: number
  fehler: number
}

async function platzAnlegen(formData: FormData) {
  'use server'
  return serverAktion('fertigung.arbeitsplatz_anlegen', { formData })
}

async function platzAendern(id: string, formData: FormData) {
  'use server'
  return serverAktion('fertigung.arbeitsplatz_aendern', { recordId: id, formData })
}

async function druckerSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.drucker_speichern', { formData })
}

async function druckerSchalten(id: string) {
  'use server'
  return serverAktion('einstellungen.drucker_schalten', { recordId: id })
}

async function druckerLoeschen(id: string) {
  'use server'
  return serverAktion('einstellungen.drucker_loeschen', { recordId: id })
}

async function druckwegSetzen(platzId: string | null, druckart: string, druckerId: string | null) {
  'use server'
  return serverAktion('einstellungen.druckweg_setzen', {
    parameter: {
      work_center_id: platzId ?? undefined,
      druckart,
      drucker_id: druckerId ?? undefined,
    },
  })
}

const mm = (v: string | null) => (v === null ? '' : String(Number(v)).replace('.', ','))

function PlatzFormular({ platz }: { platz?: Platz }) {
  return (
    <ActionForm action={platz ? platzAendern.bind(null, platz.id) : platzAnlegen}>
      <div className="row">
        {!platz && (
          <label className="field shrink">
            <span>Kürzel</span>
            <input name="code" required maxLength={20} placeholder="PACK1" style={{ width: 110 }} />
          </label>
        )}
        <label className="field" style={{ flex: 2 }}>
          <span>Name</span>
          <input name="name" defaultValue={platz?.name ?? ''} required maxLength={100} placeholder="Packtisch 1" />
        </label>
        <label className="field">
          <span>Art</span>
          <select name="art" defaultValue={platz?.art ?? 'versand'}>
            {ARBEITSPLATZ_ARTEN.map((a) => (
              <option key={a} value={a}>
                {ARBEITSPLATZ_ART_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field shrink">
          <span>Stundensatz (€)</span>
          <input
            className="mono"
            type="number"
            name="cost_per_hour"
            step="0.01"
            min="0"
            defaultValue={platz ? Number(platz.cost_per_hour) : 0}
            style={{ width: 110 }}
          />
        </label>
        {/* Kapazität/Leistung pflegt die Fertigung — hier nur mitgeben, nicht überschreiben. */}
        <input type="hidden" name="capacity" value={platz ? Number(platz.capacity) : 1} />
        <input type="hidden" name="time_efficiency" value={platz ? Number(platz.time_efficiency) : 100} />
        {platz?.note && <input type="hidden" name="note" value={platz.note} />}
        {platz && (
          <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" name="active" defaultChecked={platz.active} />
            <span>aktiv</span>
          </label>
        )}
        <div className="shrink field">
          <button className="primary" type="submit">
            {platz ? 'Speichern' : 'Arbeitsplatz anlegen'}
          </button>
        </div>
      </div>
    </ActionForm>
  )
}

function DruckerFormular({ drucker, plaetze }: { drucker?: Drucker; plaetze: Platz[] }) {
  return (
    <ActionForm action={druckerSpeichern}>
      {drucker && <input type="hidden" name="id" value={drucker.id} />}
      <div className="row">
        <label className="field" style={{ flex: 2 }}>
          <span>Name</span>
          <input
            name="name"
            defaultValue={drucker?.name ?? ''}
            required
            maxLength={100}
            placeholder="Brother QL Packtisch 1"
          />
        </label>
        <label className="field">
          <span>Steht an</span>
          <select name="work_center_id" defaultValue={drucker?.work_center_id ?? ''}>
            <option value="">— kein fester Platz —</option>
            {plaetze.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span>Name unter Windows (leer = Standarddrucker)</span>
          <input
            name="druckername"
            defaultValue={drucker?.druckername ?? ''}
            maxLength={200}
            placeholder="Brother QL-1100"
          />
        </label>
      </div>
      <div className="row">
        <label className="field shrink">
          <span>Typ</span>
          <select name="typ" defaultValue={drucker?.typ ?? 'label'}>
            <option value="label">Etikett</option>
            <option value="a4">A4</option>
          </select>
        </label>
        <label className="field shrink">
          <span>Etikett Breite (mm)</span>
          <input
            className="mono"
            type="number"
            name="breite_mm"
            step="0.1"
            min="1"
            defaultValue={mm(drucker?.breite_mm ?? null)}
            placeholder="103"
            style={{ width: 110 }}
          />
        </label>
        <label className="field shrink">
          <span>Höhe (mm)</span>
          <input
            className="mono"
            type="number"
            name="hoehe_mm"
            step="0.1"
            min="1"
            defaultValue={mm(drucker?.hoehe_mm ?? null)}
            placeholder="150"
            style={{ width: 110 }}
          />
        </label>
        <label className="field">
          <span>DHL-Format auf diesem Drucker</span>
          <select name="dhl_format" defaultValue={drucker?.dhl_format ?? ''}>
            <option value="">Standard (Versand &amp; Druck)</option>
            {DRUCKFORMATE.map((f) => (
              <option key={f.wert} value={f.wert}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <div className="shrink field">
          <button className="primary" type="submit">
            {drucker ? 'Speichern' : 'Drucker anlegen'}
          </button>
        </div>
      </div>
    </ActionForm>
  )
}

export default async function ArbeitsplaetzePage() {
  await requireArea('einstellungen')

  const plaetze = await sql<Platz[]>`
    select id, code, name, art, cost_per_hour, capacity, time_efficiency, active, note
    from work_centers
    order by active desc, art, name`
  const drucker = await sql<Drucker[]>`
    select d.id, d.name, d.work_center_id, w.name as ort, d.druckername, d.typ,
           d.breite_mm, d.hoehe_mm, d.dhl_format, d.aktiv, d.zuletzt_gesehen,
           (select count(*) from druckauftraege a
             where a.drucker_id = d.id and a.status = 'offen')::int as offen,
           (select count(*) from druckauftraege a
             where a.drucker_id = d.id and a.status = 'fehler'
               and a.created_at > now() - interval '7 days')::int as fehler
    from drucker d
    left join work_centers w on w.id = d.work_center_id
    order by d.name`
  const wege = await sql<{ work_center_id: string | null; druckart: Druckart; drucker_id: string }[]>`
    select work_center_id, druckart, drucker_id from arbeitsplatz_druckwege`
  const bruecke = await druckbrueckeKonfig()
  const brueckeAktiv = bruecke.modus === 'bruecke' && Boolean(bruecke.token)
  const hierId = await arbeitsplatzIdDesGeraets()
  const hier = plaetze.find((p) => p.id === hierId && p.active) ?? null

  const aktivePlaetze = plaetze.filter((p) => p.active)
  const weg = (platzId: string | null, art: Druckart) =>
    wege.find((w) => w.work_center_id === platzId && w.druckart === art)?.drucker_id ?? null
  const auswahl = (art: Druckart) =>
    drucker
      .filter((d) => d.aktiv)
      .map((d) => ({
        id: d.id,
        label: d.ort ? `${d.name} (${d.ort})` : d.name,
        passend: d.typ === DRUCKART_TYP[art],
      }))
  const jetzt = Date.now()

  return (
    <>
      <EinstellungenKopf href="/einstellungen/arbeitsplaetze" />

      <div className="notice info">
        Jeder PC wählt <strong>einmal oben im Kopf</strong> seinen Arbeitsplatz — ab dann druckt jede
        Anmeldung an diesem PC auf die Drucker des Platzes. Hat der Platz für eine Druckart keinen
        Drucker, springt der <strong>Ersatzdrucker</strong> ein; gibt es auch den nicht, öffnet das PDF im
        Browser. Dieser PC:{' '}
        <strong>{hier ? hier.name : 'noch kein Arbeitsplatz gewählt'}</strong>.
      </div>
      {!brueckeAktiv && (
        <div className="notice warn">
          Die Druckbrücke ist aus — alles öffnet als PDF im Browser. Einschalten unter{' '}
          <Link href="/einstellungen/versand">Versand &amp; Druck</Link>; danach gibt es hier die Pakete für
          die Drucker.
        </div>
      )}

      {brueckeAktiv && drucker.some((d) => d.aktiv) && (
        <Card title="Druckbrücke einrichten — ein Paket je Drucker">
          <ol className="small" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
            <li>Paket des Druckers herunterladen (ZIP) — am besten direkt am PC, an dem der Drucker hängt.</li>
            <li>
              ZIP in einen eigenen Ordner entpacken und <span className="mono">druckbruecke-starten.cmd</span>{' '}
              doppelklicken. Es muss nichts installiert werden (kein Node.js).
            </li>
            <li>
              Einmal <span className="mono">autostart-einrichten.cmd</span> — dann startet die Brücke mit Windows. Unten
              in der Druckerzeile steht danach „aktiv".
            </li>
          </ol>
          <div className="druck-pakete">
            {drucker
              .filter((d) => d.aktiv)
              .map((d) => (
                <div key={d.id} className="druck-paket">
                  <div>
                    <strong>{d.name}</strong>
                    {d.ort ? <span className="muted"> · {d.ort}</span> : null}
                    <div className="small mono">
                      {d.druckername ? (
                        <>Windows: {d.druckername}</>
                      ) : (
                        <span className="wv-ueberfaellig">
                          Name unter Windows fehlt — druckt auf den Standarddrucker des PCs. Unten am Drucker eintragen.
                        </span>
                      )}
                    </div>
                  </div>
                  <a className="btn primary" href={`/api/druck/paket?drucker_id=${d.id}`}>
                    Paket herunterladen
                  </a>
                </div>
              ))}
          </div>
        </Card>
      )}

      <Card title={`Arbeitsplätze (${plaetze.length})`} tight>
        {plaetze.length === 0 ? (
          <Empty>Noch keine Arbeitsplätze — unten Packtische, Montagetische usw. anlegen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Kürzel</th>
                  <th>Name</th>
                  <th>Art</th>
                  <th className="num">Stundensatz</th>
                  <th>Zustand</th>
                </tr>
              </thead>
              <tbody>
                {plaetze.map((p) => (
                  <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                    <td className="mono">{p.code}</td>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer' }}>{p.name}</summary>
                        <div style={{ marginTop: 10 }}>
                          <PlatzFormular platz={p} />
                        </div>
                      </details>
                    </td>
                    <td>{ARBEITSPLATZ_ART_LABELS[p.art]}</td>
                    <td className="num mono">{money(p.cost_per_hour)}</td>
                    <td className="nowrap">
                      <Zustand ton={p.active ? 'ok' : 'off'}>{p.active ? 'aktiv' : 'stillgelegt'}</Zustand>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div style={{ padding: '12px 14px 0' }}>
          <PlatzFormular />
          <p className="small muted" style={{ margin: '6px 0 12px' }}>
            Dieselbe Liste wie unter <Link href="/fertigung/arbeitsplaetze">Fertigung → Arbeitsplätze</Link>{' '}
            (Stundensatz, Arbeitsgänge) — ein Packtisch ist einfach ein Arbeitsplatz der Art Versand.
          </p>
        </div>
      </Card>

      <Card title={`Drucker (${drucker.length})`} tight>
        {drucker.length === 0 ? (
          <Empty>
            Noch keine Drucker — solange druckt die Brücke wie bisher über die Ziele „labeldrucker"
            und „zetteldrucker".
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Drucker</th>
                  <th>Steht an</th>
                  <th>Format</th>
                  <th>Agent</th>
                  <th className="num">Offen</th>
                  <th>Paket</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {drucker.map((d) => {
                  const gesehen = d.zuletzt_gesehen ? new Date(d.zuletzt_gesehen).getTime() : null
                  const lebt = gesehen !== null && jetzt - gesehen < AGENT_LEBT_MINUTEN * 60_000
                  return (
                    <tr key={d.id} style={d.aktiv ? undefined : { opacity: 0.55 }}>
                      <td>
                        <details>
                          <summary style={{ cursor: 'pointer' }}>{d.name}</summary>
                          <div style={{ marginTop: 10 }}>
                            <DruckerFormular drucker={d} plaetze={aktivePlaetze} />
                          </div>
                        </details>
                        <div className="small muted mono">{d.druckername || 'Standarddrucker'}</div>
                      </td>
                      <td className="small">{d.ort ?? '—'}</td>
                      <td className="small nowrap">
                        {d.typ === 'a4' ? 'A4' : `Etikett ${mm(d.breite_mm)} × ${mm(d.hoehe_mm)} mm`}
                        {d.dhl_format && <div className="muted mono">DHL {d.dhl_format}</div>}
                      </td>
                      <td className="nowrap">
                        <Zustand ton={lebt ? 'ok' : gesehen ? 'warn' : 'off'}>
                          {lebt ? 'aktiv' : gesehen ? 'still' : 'nie gemeldet'}
                        </Zustand>
                        {gesehen && <div className="small muted mono">{dateTime(d.zuletzt_gesehen)}</div>}
                      </td>
                      <td className="num mono">
                        {d.offen}
                        {d.fehler > 0 && <div className="small badge danger">{d.fehler} Fehler (7 T.)</div>}
                      </td>
                      <td className="nowrap">
                        {brueckeAktiv && (
                          <a className="btn small" href={`/api/druck/paket?drucker_id=${d.id}`}>
                            Paket laden
                          </a>
                        )}{' '}
                        <ActionButton className="small" action={druckerSchalten.bind(null, d.id)}>
                          {d.aktiv ? 'aktiv' : 'aus'}
                        </ActionButton>
                      </td>
                      <td className="num">
                        <ActionButton
                          className="small danger"
                          action={druckerLoeschen.bind(null, d.id)}
                          confirm={`Drucker „${d.name}" samt Druckwegen löschen? Offene Aufträge werden storniert.`}
                        >
                          Löschen
                        </ActionButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div style={{ padding: '12px 14px' }}>
          <DruckerFormular plaetze={aktivePlaetze} />
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            Etikettengröße nachmessen (DHL-Thermoetikett meist 103 × 150 mm bzw. 4 × 6″) — PDFs werden
            in dieser Größe gerendert und auf das Etikett eingepasst. Je Drucker ein Paket laden, am PC
            entpacken und <span className="mono">druckbruecke-starten.cmd</span> starten; zwei Drucker an
            einem PC = zwei Pakete in zwei Ordnern.
          </p>
        </div>
      </Card>

      <Card title="Druckwege" tight>
        {drucker.filter((d) => d.aktiv).length === 0 ? (
          <Empty>Erst einen Drucker anlegen — dann hier je Arbeitsplatz und Druckart zuordnen.</Empty>
        ) : (
          <TableWrap>
            <table className="druckwege">
              <thead>
                <tr>
                  <th>Arbeitsplatz</th>
                  {DRUCKARTEN.map((art) => (
                    <th key={art}>{DRUCKART_LABELS[art]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {aktivePlaetze.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      <div className="small muted">{ARBEITSPLATZ_ART_LABELS[p.art]}</div>
                    </td>
                    {DRUCKARTEN.map((art) => (
                      <td key={art}>
                        <DruckwegWahl
                          wert={weg(p.id, art)}
                          drucker={auswahl(art)}
                          leer={weg(null, art) ? '— Ersatz —' : '— Browser —'}
                          action={druckwegSetzen.bind(null, p.id, art)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Ersatz</strong>
                    <div className="small muted">alle Plätze ohne eigenen Weg</div>
                  </td>
                  {DRUCKARTEN.map((art) => (
                    <td key={art}>
                      <DruckwegWahl
                        wert={weg(null, art)}
                        drucker={auswahl(art)}
                        leer="— Browser —"
                        action={druckwegSetzen.bind(null, null, art)}
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
