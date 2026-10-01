'use client'
import { useState } from 'react'
import { useAnsage } from '@/components/use-ansage'
import { Packtisch } from '../packtisch/packtisch'
import type { PacktischDoc } from '@/modules/versand/packtisch-beleg'
import { Scanner } from './scanner'

/**
 * Das EINE Scanfeld (Entscheidungslog 2026-10-01): die gescannte Nummer
 * entscheidet den Ablauf. Lieferung/Packzettel → Packablauf (Artikel
 * gegenscannen → Label, Warenausgang, Shop-Rückmeldung); Wareneingang,
 * Transfer und Fertigungsauftrag → Checkliste des Scanners. Nach einem
 * Paket geht der nächste Scan zurück an den Scanner, der ihn wieder
 * zuordnet — ein Fließband ohne Seitenwechsel.
 */
export function ScanArbeitsplatz({
  canPickings,
  canMos,
  canVersand,
}: {
  canPickings: boolean
  canMos: boolean
  canVersand: boolean
}) {
  const [lauf, setLauf] = useState<{ versand: PacktischDoc | null; startCode?: string; n: number }>({
    versand: null,
    n: 0,
  })
  // Sprachansagen (Stimme wie „Sprechen") — gilt für beide Abläufe.
  const stimme = useAnsage()

  return (
    <>
      <div className="actions" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        {/* Schalter je Gerät; ohne konfigurierte Stimme piept das Scanfeld wie bisher. */}
        <button
          type="button"
          className="small"
          onClick={stimme.umschalten}
          aria-pressed={stimme.an}
          title={
            stimme.verfuegbar === false
              ? 'Keine Stimme konfiguriert — das Scanfeld piept'
              : 'Ansagen wie „Gebucht", „Falscher Artikel", „Nicht gefunden"'
          }
        >
          <span className={`led ${stimme.an && stimme.verfuegbar !== false ? 'ok' : 'off'}`} />{' '}
          Stimme {stimme.an ? (stimme.verfuegbar === false ? 'nicht verfügbar' : 'an') : 'aus'}
        </button>
      </div>
      {lauf.versand ? (
        <Packtisch
          key={lauf.n}
          startDoc={lauf.versand}
          ansagen={stimme.ansagen}
          onEnde={(code) => setLauf((l) => ({ versand: null, startCode: code, n: l.n + 1 }))}
        />
      ) : (
        <Scanner
          key={lauf.n}
          canPickings={canPickings}
          canMos={canMos}
          canVersand={canVersand}
          startCode={lauf.startCode}
          ansagen={stimme.ansagen}
          onVersand={(doc) => setLauf((l) => ({ versand: doc, n: l.n + 1 }))}
        />
      )}
    </>
  )
}
