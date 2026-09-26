'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { EINSTELLUNGS_BEREICHE, GRUPPEN, aktiverBereich } from '@/modules/einstellungen/bereiche'

/**
 * Linke Unternavigation der Einstellungen (Entscheidungslog 2026-09-26):
 * gruppiert, genau ein Eintrag aktiv (längster passender Pfad), auf dem
 * Telefon eine waagerechte Chip-Leiste. Die Einträge kommen aus
 * modules/einstellungen/bereiche.ts — keine zweite Liste.
 */
export function EinstellungenNav() {
  const aktiv = aktiverBereich(usePathname())
  return (
    <nav className="einstellungen-nav" aria-label="Einstellungen">
      {GRUPPEN.map((gruppe) => (
        <div key={gruppe} className="einstellungen-gruppe">
          <div className="mono-label">{gruppe}</div>
          {EINSTELLUNGS_BEREICHE.filter((b) => b.gruppe === gruppe).map((b) => (
            <Link
              key={b.href}
              href={b.href}
              className={`einstellungen-link${b.gefahr ? ' gefahr' : ''}`}
              aria-current={b.href === aktiv ? 'page' : undefined}
            >
              {b.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
