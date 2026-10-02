'use client'
import type { ReactNode } from 'react'

/**
 * Link auf ein <details> weiter unten: klappt es auf und scrollt hin. Ein
 * bloßer #Anker lässt das Element zugeklappt (z. B. „Ändern" am Angebot →
 * Formular „Angebot ändern").
 */
export function AufklappLink({ ziel, className, children }: { ziel: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={`#${ziel}`}
      className={className}
      onClick={(e) => {
        const el = document.getElementById(ziel)
        if (!(el instanceof HTMLDetailsElement)) return
        e.preventDefault()
        el.open = true
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        el.querySelector<HTMLElement>('input:not([type=hidden]), textarea')?.focus({ preventScroll: true })
      }}
    >
      {children}
    </a>
  )
}
