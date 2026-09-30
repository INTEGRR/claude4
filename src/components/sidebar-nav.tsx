'use client'
import Link from 'next/link'
import { useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { navigationMerken } from '@/app/(erp)/nav-action'

/**
 * Gruppierte, aufklappbare Navigation (Claude-Code-Stil). Die Gruppen kommen
 * bereits rollengefiltert aus dem Server-Layout. Standard: alles
 * eingeklappt; welche Gruppen jemand öffnet, merkt sich KRNL am Benutzer
 * (users.nav_offen, 0095) — derselbe Zustand an jedem Gerät, und Server
 * und Client rendern von Anfang an gleich. Die Gruppe der aktuellen Seite
 * klappt NICHT von selbst auf; ist sie zu, trägt ihr Kopf die Markierung.
 */

export interface NavItem {
  href: string
  label: string
  count?: number
}

export interface NavGroup {
  /** null = ungruppierte Einzellinks (immer sichtbar, kein Kopf) */
  label: string | null
  items: NavItem[]
}

function NavEntry({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link className="nav" href={item.href} aria-current={active ? 'page' : undefined}>
      <span>{item.label}</span>
      {item.count !== undefined && item.count > 0 && <span className="badge neutral">{item.count}</span>}
    </Link>
  )
}

export function SidebarNav({ groups, offen: gespeichert }: { groups: NavGroup[]; offen: string[] }) {
  const pathname = usePathname()
  const [offen, setOffen] = useState<string[]>(gespeichert)
  const [, startTransition] = useTransition()

  // Genau ein Eintrag ist aktiv: der mit dem längsten passenden Pfad. Sonst
  // leuchtete auf /personal/schichtplan auch „Mitarbeiter" (/personal) mit.
  const passt = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/')
  const aktiv = groups
    .flatMap((g) => g.items.map((i) => i.href))
    .filter(passt)
    .sort((a, b) => b.length - a.length)[0]
  const isActive = (href: string) => href === aktiv

  const toggle = (label: string) => {
    const next = offen.includes(label) ? offen.filter((g) => g !== label) : [...offen, label]
    setOffen(next)
    startTransition(() => {
      void navigationMerken(next)
    })
  }

  return (
    <>
      {groups.map((g, i) => {
        if (!g.label) {
          return g.items.map((item) => (
            <NavEntry key={item.href} item={item} active={isActive(item.href)} />
          ))
        }
        const isClosed = !offen.includes(g.label)
        const enthaeltAktiv = g.items.some((item) => isActive(item.href))
        return (
          <div key={g.label ?? i} className="nav-group">
            <button
              type="button"
              className={`nav-group-head${isClosed && enthaeltAktiv ? ' aktiv' : ''}`}
              onClick={() => toggle(g.label!)}
              aria-expanded={!isClosed}
            >
              <span className={`chevron${isClosed ? '' : ' open'}`} aria-hidden>
                ▸
              </span>
              {g.label}
              {isClosed && (
                <span className="nav-group-sum">
                  {g.items.reduce((sum, item) => sum + (item.count ?? 0), 0) || ''}
                </span>
              )}
            </button>
            {!isClosed &&
              g.items.map((item) => (
                <NavEntry key={item.href} item={item} active={isActive(item.href)} />
              ))}
          </div>
        )
      })}
    </>
  )
}
