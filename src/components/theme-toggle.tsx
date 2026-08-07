'use client'
import { useEffect, useState } from 'react'

/**
 * Hell / Dunkel / System. Die Wahl steht in localStorage und wird als
 * data-theme an <html> gesetzt; das CSS in globals.css liest sie dort.
 * Ohne ausdrückliche Wahl gilt die Systemeinstellung.
 */

type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'erp.theme'

/**
 * Läuft vor dem ersten Rendern (im <head>), damit die Seite nie kurz in der
 * falschen Helligkeit aufblitzt.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`

function apply(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') setTheme(stored)
  }, [])

  const choose = (next: Theme) => {
    setTheme(next)
    apply(next)
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  }

  const OPTIONS: { key: Theme; label: string; title: string }[] = [
    { key: 'light', label: 'Hell', title: 'Helles Erscheinungsbild' },
    { key: 'dark', label: 'Dunkel', title: 'Dunkles Erscheinungsbild' },
    { key: 'system', label: 'Auto', title: 'Der Systemeinstellung folgen' },
  ]

  return (
    <div className="theme-toggle" role="group" aria-label="Erscheinungsbild">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          aria-pressed={theme === o.key}
          onClick={() => choose(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
