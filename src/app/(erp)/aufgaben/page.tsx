import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { AufgabenListe } from '@/components/aufgaben-liste'
import { Card, Empty, PageHeader } from '@/components/ui'
import { type AufgabenFilter, aufgabenListe } from '@/modules/aufgaben/liste'
import { TEAMS, heuteInBerlin } from '@/modules/aufgaben/termin'
import { aufgabeAnlegen } from './actions'

export const dynamic = 'force-dynamic'

const FILTER: { wert: AufgabenFilter; label: string }[] = [
  { wert: 'meine', label: 'Meine' },
  { wert: 'offen', label: 'Alle offenen' },
  { wert: 'erledigt', label: 'Erledigt (14 Tage)' },
]

/**
 * Aufgaben für Mitarbeiter (0104): anlegen, zuweisen (Person oder Team),
 * mit Termin — und abhaken. Dieselben Aufgaben erscheinen beim Zuständigen
 * in der Übersicht; per Sprechen geht das Anlegen auch („Leg für Tino an:
 * Lager durchfegen, heute 15 Uhr").
 */
export default async function AufgabenPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await requireArea('aufgaben')
  const { filter: roh } = await searchParams
  const filter: AufgabenFilter = FILTER.some((f) => f.wert === roh) ? (roh as AufgabenFilter) : 'meine'

  const [aufgaben, nutzer] = await Promise.all([
    aufgabenListe(user, filter),
    sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
  ])
  const nutzerSicht = { id: user.id, rollen: user.rollen }

  return (
    <>
      <PageHeader title="Aufgaben" subtitle="Wer was bis wann erledigt — erscheint beim Zuständigen in der Übersicht" />

      <Card title="Neue Aufgabe">
        <ActionForm action={aufgabeAnlegen}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Was ist zu tun?</span>
              <input name="titel" required maxLength={200} placeholder="z. B. Lager hinten durchfegen" />
            </label>
            <label className="field" style={{ flex: 1.4 }}>
              <span>Für</span>
              <select name="zustaendig" defaultValue="">
                <option value="">mich</option>
                <optgroup label="Team">
                  {Object.entries(TEAMS).map(([rolle, name]) => (
                    <option key={rolle} value={`rolle:${rolle}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Person">
                  {nutzer
                    .filter((u) => u.id !== user.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field shrink">
              <span>Fällig am</span>
              <input name="faellig_am" type="date" required defaultValue={heuteInBerlin()} min={heuteInBerlin()} />
            </label>
            <label className="field shrink">
              <span>Uhrzeit</span>
              <input name="uhrzeit" type="time" />
            </label>
            <label className="field shrink">
              <span>Dauer (min)</span>
              <input name="dauer_min" type="number" min={5} max={1440} step={5} placeholder="30" style={{ width: 90 }} />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Details</span>
              <input name="beschreibung" maxLength={2000} placeholder="optional" />
            </label>
            <div className="field shrink">
              <button className="primary" type="submit">
                Anlegen
              </button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {FILTER.map((f) => (
            <Link
              key={f.wert}
              className="btn small"
              href={f.wert === 'meine' ? '/aufgaben' : `/aufgaben?filter=${f.wert}`}
              aria-current={filter === f.wert ? 'page' : undefined}
            >
              <span className={filter === f.wert ? 'led on' : 'led off'} /> {f.label}
            </Link>
          ))}
        </div>
        {aufgaben.length === 0 ? (
          <Empty>
            {filter === 'meine'
              ? 'Keine offenen Aufgaben für dich.'
              : filter === 'offen'
                ? 'Keine offenen Aufgaben.'
                : 'In den letzten 14 Tagen nichts erledigt.'}
          </Empty>
        ) : (
          <AufgabenListe aufgaben={aufgaben} nutzer={nutzerSicht} zeigeZustaendig={filter !== 'meine'} verwerfen />
        )}
      </Card>
    </>
  )
}
