'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Gruppierte, aufklappbare Navigation (Claude-Code-Stil). Die Gruppen kommen
 * bereits rollengefiltert aus dem Server-Layout; hier lebt nur der
 * Auf-/Zuklapp-Zustand (localStorage, Standard: offen). Die Gruppe der
 * aktiven Route ist immer geöffnet.
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

const STORAGE_PREFIX = 'erp.nav.'

function NavEntry({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link className="nav" href={item.href} aria-current={active ? 'page' : undefined}>
      <span>{item.label}</span>
      {item.count !== undefined && item.count > 0 && <span className="badge neutral">{item.count}</span>}
    </Link>
  )
}

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname()
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  // Zustand erst nach dem Mount laden — Server und Client rendern initial
  // identisch (alles offen), danach klappt der gespeicherte Zustand zu.
  useEffect(() => {
    const fromStorage: Record<string, boolean> = {}
    for (const g of groups) {
      if (g.label && localStorage.getItem(STORAGE_PREFIX + g.label) === 'zu') {
        fromStorage[g.label] = true
      }
    }
    setClosed(fromStorage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))

  const toggle = (label: string) => {
    setClosed((c) => {
      const next = { ...c, [label]: !c[label] }
      localStorage.setItem(STORAGE_PREFIX + label, next[label] ? 'zu' : 'auf')
      return next
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
        // Die Gruppe der aktiven Seite bleibt offen, egal was gespeichert ist.
        const containsActive = g.items.some((item) => isActive(item.href))
        const isClosed = closed[g.label] === true && !containsActive
        return (
          <div key={g.label ?? i} className="nav-group">
            <button
              type="button"
              className="nav-group-head"
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
