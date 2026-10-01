import { ActionButton } from '@/components/action-button'
import { aufgabeErledigen, aufgabeVerwerfen } from '@/app/(erp)/aufgaben/actions'
import type { AufgabeZeile } from '@/modules/aufgaben/liste'
import { darfAbhaken, darfVerwerfen, type NutzerSicht } from '@/modules/aufgaben/rechte'
import { TEAMS } from '@/modules/aufgaben/termin'
import { date, dateTime } from '@/modules/shared/format'

/**
 * Aufgaben als Liste (0104) — dieselbe Zeile in der Übersicht („Deine
 * Aufgaben") und auf /aufgaben. Überfälliges leuchtet gelb, Heutiges
 * orange; Knöpfe nur, wo die Aktion auch durchginge (aufgaben/rechte.ts).
 */

export function termin(a: Pick<AufgabeZeile, 'faellig_am' | 'uhrzeit' | 'heute'>): string {
  return `${a.heute ? 'heute' : date(a.faellig_am)}${a.uhrzeit ? `, ${a.uhrzeit} Uhr` : ''}`
}

export function wer(a: Pick<AufgabeZeile, 'zustaendig' | 'rolle'>): string {
  if (a.zustaendig) return a.zustaendig
  if (a.rolle) return `Team ${TEAMS[a.rolle as keyof typeof TEAMS] ?? a.rolle}`
  return 'niemand'
}

export function AufgabenListe({
  aufgaben,
  nutzer,
  zeigeZustaendig = false,
  verwerfen = false,
}: {
  aufgaben: AufgabeZeile[]
  nutzer: NutzerSicht
  /** Auf /aufgaben (alle offenen) — in „Deine Aufgaben" ist es klar. */
  zeigeZustaendig?: boolean
  verwerfen?: boolean
}) {
  return (
    <ul className="dok-liste aufgaben-liste">
      {aufgaben.map((a) => {
        const offen = a.status === 'offen'
        const led = !offen ? 'off' : a.ueberfaellig ? 'warn' : a.heute ? 'on' : 'off'
        return (
          <li key={a.id} className="dok-zeile">
            <div className="dok-text">
              <div>
                <span className={`led ${led}`} /> <strong>{a.titel}</strong>
              </div>
              <div className="muted small">
                {offen ? (
                  <span className={a.ueberfaellig ? 'wv-ueberfaellig' : undefined}>
                    {termin(a)}
                    {a.ueberfaellig ? ' · überfällig' : ''}
                  </span>
                ) : (
                  <span>
                    {a.status === 'erledigt' ? 'erledigt' : 'verworfen'} {dateTime(a.erledigt_am)} von {a.erledigt_von}
                  </span>
                )}
                {a.dauer_min ? ` · ca. ${a.dauer_min} min` : ''}
                {zeigeZustaendig ? ` · für ${wer(a)}` : a.rolle && !a.zustaendig ? ` · ${wer(a)}` : ''}
                {` · von ${a.erstellt_von}`}
              </div>
              {a.beschreibung && <div className="small">{a.beschreibung}</div>}
              {a.notiz && <div className="small muted">Rückmeldung: {a.notiz}</div>}
            </div>
            {offen && (
              <div className="actions" style={{ flexWrap: 'nowrap' }}>
                {verwerfen && darfVerwerfen(a, nutzer) && (
                  <ActionButton
                    className="small danger"
                    action={aufgabeVerwerfen.bind(null, a.id)}
                    confirm={`„${a.titel}" verwerfen?`}
                  >
                    Verwerfen
                  </ActionButton>
                )}
                {darfAbhaken(a, nutzer) && (
                  <ActionButton className="small primary" action={aufgabeErledigen.bind(null, a.id)}>
                    Erledigt
                  </ActionButton>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
