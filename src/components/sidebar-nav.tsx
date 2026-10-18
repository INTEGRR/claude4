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
 * und Client rendern von Anfang an gleich. Seit 2026-10-18 (UX-Audit A00#2)
 * steht die Gruppe der aktuellen Seite immer offen — wer sie in dieser
 * Sitzung bewusst zuklappt, behält sie zu; gespeichert wird nur die eigene
 * Auswahl.
 */

export interface NavItem {
  href: string
  label: string
  count?: number
  /** Kernfunktion, dauerhaft farbig markiert (Sprechen orange). */
  kern?: 'orange'
}

export interface NavGroup {
  /** null = ungruppierte Einzellinks (immer sichtbar, kein Kopf) */
  label: string | null
  items: NavItem[]
}

function NavEntry({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      className={`nav${item.kern ? ` kern-${item.kern}` : ''}`}
      href={item.href}
      aria-current={active ? 'page' : undefined}
    >
      <span>{item.label}</span>
      {item.count !== undefined && item.count > 0 && <span className="badge neutral">{item.count}</span>}
    </Link>
  )
}

export function SidebarNav({ groups, offen: gespeichert }: { groups: NavGroup[]; offen: string[] }) {
  const pathname = usePathname()
  const [offen, setOffen] = useState<string[]>(gespeichert)
  /** In dieser Sitzung bewusst zugeklappt — gilt auch für die Gruppe der aktuellen Seite. */
  const [zu, setZu] = useState<string[]>([])
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

  const gruppeAktiv = groups.find((g) => g.label && g.items.some((i) => isActive(i.href)))?.label ?? null
  const istOffen = (label: string) =>
    !zu.includes(label) && (offen.includes(label) || label === gruppeAktiv)

  const toggle = (label: string) => {
    const warOffen = istOffen(label)
    setZu(warOffen ? [...zu, label] : zu.filter((g) => g !== label))
    const next = warOffen ? offen.filter((g) => g !== label) : [...offen.filter((g) => g !== label), label]
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
        const isClosed = !istOffen(g.label)
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
