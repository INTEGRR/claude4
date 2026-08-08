'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Rahmen der Anwendung. Auf dem Rechner steht die Navigation fest links, auf
 * schmalen Geräten fährt sie über den Inhalt und wird über „Menü" geöffnet.
 *
 * Der Zustand lebt hier und nicht in CSS allein, weil die Navigation sich nach
 * dem Antippen eines Eintrags wieder schließen muss — sonst verdeckt sie die
 * Seite, zu der man gerade wollte.
 */
export function AppShell({
  sidebar,
  topbar,
  children,
}: {
  sidebar: React.ReactNode
  topbar: React.ReactNode
  children: React.ReactNode
}) {
  const [offen, setOffen] = useState(false)
  const pathname = usePathname()

  // Seitenwechsel schließt die Navigation.
  useEffect(() => setOffen(false), [pathname])

  // Solange sie offen ist, soll der Inhalt darunter nicht mitscrollen.
  useEffect(() => {
    document.body.style.overflow = offen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [offen])

  return (
    <div className={`app${offen ? ' nav-offen' : ''}`}>
      <nav className="sidebar" id="hauptnavigation">
        {sidebar}
      </nav>

      {/* Fläche zum Schließen — nur auf schmalen Geräten sichtbar. */}
      <button
        type="button"
        className="nav-schatten"
        aria-label="Navigation schließen"
        tabIndex={offen ? 0 : -1}
        onClick={() => setOffen(false)}
      />

      <div className="main">
        <div className="topbar">
          <button
            type="button"
            className="nav-schalter small"
            aria-expanded={offen}
            aria-controls="hauptnavigation"
            onClick={() => setOffen((o) => !o)}
          >
            {offen ? '✕' : '☰'} Menü
          </button>
          {topbar}
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
