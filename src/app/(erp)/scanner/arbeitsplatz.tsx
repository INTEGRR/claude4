'use client'
import { useState } from 'react'
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

  if (lauf.versand) {
    return (
      <Packtisch
        key={lauf.n}
        startDoc={lauf.versand}
        onEnde={(code) => setLauf((l) => ({ versand: null, startCode: code, n: l.n + 1 }))}
      />
    )
  }
  return (
    <Scanner
      key={lauf.n}
      canPickings={canPickings}
      canMos={canMos}
      canVersand={canVersand}
      startCode={lauf.startCode}
      onVersand={(doc) => setLauf((l) => ({ versand: doc, n: l.n + 1 }))}
    />
  )
}
