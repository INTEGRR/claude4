'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * Artikelnummer-Vorschlag an Eingabefeldern (2026-11-28). KRNL schlägt nach
 * dem Muster vor (shared/artikelnummer.ts) — übernommen wird per Klick,
 * gespeichert wird, was im Feld steht.
 */

/** Wert so setzen, dass auch React (Hinweis „noch nicht gespeichert") es mitbekommt. */
function setzen(feld: HTMLInputElement, wert: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(feld, wert)
  feld.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Knopf neben einem Feld: trägt den Vorschlag ein. `feld` ist der name des Eingabefelds im selben Formular. */
export function VorschlagKnopf({ feld, vorschlag }: { feld: string; vorschlag: string }) {
  return (
    <button
      type="button"
      className="small vorschlag-knopf mono"
      title="Vorschlag nach dem Nummernmuster übernehmen"
      onClick={(e) => {
        const ziel = e.currentTarget.closest('form')?.querySelector<HTMLInputElement>(`input[name="${CSS.escape(feld)}"]`)
        if (ziel) setzen(ziel, vorschlag)
      }}
    >
      ← {vorschlag}
    </button>
  )
}

/** Füllt alle leeren Felder des Formulars, die einen Vorschlag tragen (data-vorschlag). */
export function AlleVorschlaege({ anzahl }: { anzahl: number }) {
  return (
    <button
      type="button"
      className="small"
      onClick={(e) => {
        for (const feld of e.currentTarget.closest('form')?.querySelectorAll<HTMLInputElement>('input[data-vorschlag]') ?? []) {
          if (!feld.value.trim() && feld.dataset.vorschlag) setzen(feld, feld.dataset.vorschlag)
        }
      }}
    >
      {anzahl === 1 ? 'Vorschlag übernehmen' : `Alle ${anzahl} Vorschläge übernehmen`}
    </button>
  )
}

/**
 * Für Anlage-Formulare: beobachtet das Namensfeld des Formulars und bietet zum
 * getippten Namen eine Artikelnummer an, solange das Nummernfeld leer ist.
 */
export function VorschlagZumNamen({ nameFeld = 'name', feld = 'sku' }: { nameFeld?: string; feld?: string }) {
  const anker = useRef<HTMLSpanElement>(null)
  const [vorschlag, setVorschlag] = useState<string | null>(null)

  useEffect(() => {
    const form = anker.current?.closest('form')
    const quelle = form?.querySelector<HTMLInputElement>(`input[name="${CSS.escape(nameFeld)}"]`)
    if (!quelle) return
    let warten: ReturnType<typeof setTimeout> | undefined
    let aktuell = 0
    const holen = () => {
      clearTimeout(warten)
      const name = quelle.value.trim()
      if (name.length < 3) return setVorschlag(null)
      const lauf = ++aktuell
      warten = setTimeout(async () => {
        try {
          const res = await fetch(`/api/artikelnummer?name=${encodeURIComponent(name)}`)
          const daten = (await res.json()) as { vorschlag?: string | null }
          if (lauf === aktuell) setVorschlag(daten.vorschlag ?? null)
        } catch {
          // ohne Verbindung kein Vorschlag — das Feld bleibt frei beschreibbar
        }
      }, 300)
    }
    quelle.addEventListener('input', holen)
    holen()
    return () => {
      quelle.removeEventListener('input', holen)
      clearTimeout(warten)
    }
  }, [nameFeld])

  return (
    <span ref={anker}>
      {vorschlag && <VorschlagKnopf feld={feld} vorschlag={vorschlag} />}
    </span>
  )
}
