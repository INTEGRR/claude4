'use client'
import { useEffect, useRef } from 'react'

/**
 * Tabelle, die am Handy zu Karten wird (Entscheidungslog 2026-10-18,
 * UX-Audit M17): jede Zeile eine Karte, jede Zelle „Spaltenkopf: Wert".
 * Die Beschriftung kommt aus dem <thead> — die Seite schreibt keine
 * doppelten Labels; bis zur Hydration bleibt die Tabelle quer scrollbar.
 */
export function KartenTabelle({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tabelle = ref.current?.querySelector('table')
    if (!tabelle) return
    const koepfe = [...tabelle.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '')
    for (const zeile of tabelle.querySelectorAll('tbody tr')) {
      ;[...zeile.children].forEach((zelle, i) => {
        if (!zelle.hasAttribute('data-label')) zelle.setAttribute('data-label', koepfe[i] ?? '')
      })
    }
  })
  return (
    <div ref={ref} className="table-wrap karten">
      {children}
    </div>
  )
}
