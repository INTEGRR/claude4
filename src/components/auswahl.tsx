'use client'
import {
  Children,
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type AuswahlOption, filtern, normalisieren, startwert } from './auswahl-logik'

/**
 * Auswahlbox mit Suche — ersetzt <select> in ganz KRNL (Betreiber
 * 2026-10-02: „Dropdowns müssen eine interaktive Box mit Filter/Suche sein").
 *
 * Bewusst als Austausch gebaut: dieselben Kinder (<option>, <optgroup>),
 * dieselben Props (name, defaultValue, required, multiple, disabled) und
 * dieselben Formularwerte wie ein natives <select> — Server Actions merken
 * keinen Unterschied. Der Wächter tests/auswahl.test.ts verbietet <select>
 * im internen Teil.
 *
 * - Knopf zeigt die Wahl; Klick, Pfeiltaste oder Tippen öffnet die Liste.
 * - Ab acht Optionen steht oben ein Suchfeld (Wörter in beliebiger
 *   Reihenfolge, ohne Akzente; `data-suche` an der Option sucht mit).
 * - Liste im Top-Layer (popover): wird weder von Tabellen abgeschnitten
 *   noch von Dialogen verdeckt; klappt nach oben, wenn unten kein Platz ist.
 * - Formular: versteckte Felder tragen den Wert, ein unsichtbares
 *   Pflichtfeld meldet `required`; Zurücksetzen des Formulars stellt die
 *   Vorgabe wieder her.
 */

const SUCHE_AB = 8

interface Props {
  name?: string
  defaultValue?: string | number | readonly string[]
  /** Gesteuert (Client-Komponenten); dann meldet onAuswahl die Wahl. */
  value?: string
  onAuswahl?: (wert: string) => void
  required?: boolean
  disabled?: boolean
  multiple?: boolean
  /** Text im Knopf, solange nichts gewählt ist (Mehrfachauswahl). */
  placeholder?: string
  id?: string
  className?: string
  style?: CSSProperties
  title?: string
  'aria-label'?: string
  'aria-invalid'?: boolean
  children?: ReactNode
}

function textVon(knoten: ReactNode): string {
  if (knoten == null || typeof knoten === 'boolean') return ''
  if (typeof knoten === 'string' || typeof knoten === 'number') return String(knoten)
  if (Array.isArray(knoten)) return knoten.map(textVon).join('')
  if (isValidElement<{ children?: ReactNode }>(knoten)) return textVon(knoten.props.children)
  return ''
}

interface OptionProps {
  value?: string | number
  label?: string
  disabled?: boolean
  children?: ReactNode
  'data-suche'?: string
}

/** <option>/<optgroup>-Kinder (auch in Fragmenten und Arrays) als flache Liste. */
function optionenAus(
  kinder: ReactNode,
  gruppe?: { text: string; gesperrt: boolean },
  aus: AuswahlOption[] = [],
): AuswahlOption[] {
  Children.forEach(kinder, (kind) => {
    if (!isValidElement<OptionProps>(kind)) return
    const p = kind.props
    if (kind.type === Fragment) {
      optionenAus(p.children, gruppe, aus)
    } else if (kind.type === 'optgroup') {
      optionenAus(p.children, { text: p.label ?? '', gesperrt: Boolean(p.disabled) }, aus)
    } else if (kind.type === 'option') {
      const text = textVon(p.children).replace(/\s+/g, ' ').trim()
      aus.push({
        wert: p.value != null ? String(p.value) : text,
        text,
        gruppe: gruppe?.text,
        deaktiviert: Boolean(p.disabled) || Boolean(gruppe?.gesperrt),
        suche: normalisieren(`${text} ${p['data-suche'] ?? ''} ${gruppe?.text ?? ''}`),
      })
    }
  })
  return aus
}

function alsListe(wert: string | string[]): string[] {
  return Array.isArray(wert) ? wert : [wert]
}

export function Auswahl({
  name,
  defaultValue,
  value,
  onAuswahl,
  required,
  disabled,
  multiple = false,
  placeholder,
  id,
  className,
  style,
  title,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  children,
}: Props) {
  const optionen = useMemo(() => optionenAus(children), [children])
  const gesteuert = value !== undefined
  const [eigen, setEigen] = useState<string | string[]>(() => startwert(optionen, defaultValue, multiple))
  const wert: string | string[] = gesteuert ? value : eigen
  const gewaehlt = alsListe(wert)

  // Neue Vorgabe vom Server (nach dem Speichern) übernehmen, solange nichts
  // von Hand geändert wurde — wie es ein unberührtes Formularfeld täte.
  const vorgabeSchluessel = JSON.stringify(defaultValue ?? null)
  const letzteVorgabe = useRef(vorgabeSchluessel)
  const geaendert = useRef(false)
  useEffect(() => {
    if (letzteVorgabe.current === vorgabeSchluessel) return
    letzteVorgabe.current = vorgabeSchluessel
    if (!geaendert.current) setEigen(startwert(optionen, defaultValue, multiple))
  }, [vorgabeSchluessel, optionen, defaultValue, multiple])

  const [offen, setOffen] = useState(false)
  const [eingabe, setEingabe] = useState('')
  const [aktiv, setAktiv] = useState(0)
  const [ungueltig, setUngueltig] = useState(false)

  const huelle = useRef<HTMLSpanElement>(null)
  const knopf = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const suche = useRef<HTMLInputElement>(null)
  const liste = useRef<HTMLDivElement>(null)
  const geschlossenUm = useRef(0)
  const basisId = useId()
  const panelId = `${basisId}-liste`

  const mitSuche = optionen.length >= SUCHE_AB
  const { treffer, mehr } = useMemo(
    () => (offen ? filtern(optionen, eingabe) : { treffer: [], mehr: 0 }),
    [offen, optionen, eingabe],
  )

  // Formular zurückgesetzt (ActionForm nach Erfolg) → Vorgabe wiederherstellen.
  const vorgabeRef = useRef(defaultValue)
  vorgabeRef.current = defaultValue
  useEffect(() => {
    const formular = huelle.current?.closest('form')
    if (!formular) return
    const zuruecksetzen = () => {
      geaendert.current = false
      setUngueltig(false)
      setEigen(startwert(optionen, vorgabeRef.current, multiple))
    }
    formular.addEventListener('reset', zuruecksetzen)
    return () => formular.removeEventListener('reset', zuruecksetzen)
  }, [optionen, multiple])

  // Offen/zu kommt vom Popover selbst (auch Klick daneben, Escape).
  useEffect(() => {
    const el = panel.current
    if (!el) return
    const vorher = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') geschlossenUm.current = performance.now()
    }
    const danach = (e: Event) => {
      const auf = (e as ToggleEvent).newState === 'open'
      setOffen(auf)
      if (!auf) setEingabe('')
    }
    el.addEventListener('beforetoggle', vorher)
    el.addEventListener('toggle', danach)
    // Vor der Hydrierung öffnet popovertarget die Liste nativ — dann jetzt füllen.
    if (el.matches(':popover-open')) setOffen(true)
    return () => {
      el.removeEventListener('beforetoggle', vorher)
      el.removeEventListener('toggle', danach)
    }
  }, [])

  // Unter (oder über) den Knopf legen und beim Scrollen mitführen.
  useEffect(() => {
    if (!offen) return
    const platzieren = () => {
      const k = knopf.current
      const p = panel.current
      if (!k || !p) return
      const r = k.getBoundingClientRect()
      const sicht = window.visualViewport
      const hoehe = sicht?.height ?? window.innerHeight
      const breiteFenster = document.documentElement.clientWidth
      const breite = Math.min(Math.max(r.width, 240), breiteFenster - 16)
      const links = Math.min(Math.max(r.left, 8), breiteFenster - breite - 8)
      const unten = hoehe - r.bottom - 8
      const oben = r.top - 8
      p.style.left = `${links}px`
      p.style.width = `${breite}px`
      if (unten >= 220 || unten >= oben) {
        p.style.top = `${r.bottom + 4}px`
        p.style.bottom = 'auto'
        p.style.maxHeight = `${Math.min(380, unten - 4)}px`
      } else {
        p.style.top = 'auto'
        p.style.bottom = `${window.innerHeight - r.top + 4}px`
        p.style.maxHeight = `${Math.min(380, oben - 4)}px`
      }
    }
    platzieren()
    window.addEventListener('scroll', platzieren, true)
    window.addEventListener('resize', platzieren)
    window.visualViewport?.addEventListener('resize', platzieren)
    return () => {
      window.removeEventListener('scroll', platzieren, true)
      window.removeEventListener('resize', platzieren)
      window.visualViewport?.removeEventListener('resize', platzieren)
    }
  }, [offen])

  // Aktive Zeile sichtbar halten.
  useEffect(() => {
    if (!offen) return
    liste.current?.querySelector<HTMLElement>(`[data-index="${aktiv}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [aktiv, offen])

  function ersteFreie(liste: AuswahlOption[], ab = 0, schritt = 1): number {
    for (let i = ab; i >= 0 && i < liste.length; i += schritt) if (!liste[i].deaktiviert) return i
    return -1
  }

  function oeffnen(start = '') {
    const p = panel.current
    if (!p || disabled) return
    setEingabe(start)
    // Startzeile: die aktuelle Wahl, sonst die erste freie Option.
    // (Ohne Eingabe zeigt die Liste die ersten 200 — weiter hinten bleibt die erste freie aktiv.)
    const index = start ? -1 : optionen.findIndex((o) => o.wert === gewaehlt[0] && !o.deaktiviert)
    const sichtbar = filtern(optionen, start).treffer
    setAktiv(index >= 0 && index < sichtbar.length ? index : Math.max(0, ersteFreie(sichtbar)))
    try {
      p.showPopover()
    } catch {
      return
    }
    // Gleich füllen, nicht erst auf das (asynchrone) toggle-Ereignis warten.
    setOffen(true)
    // Im selben Klick fokussieren — sonst öffnet iOS die Tastatur nicht.
    if (mitSuche) suche.current?.focus({ preventScroll: true })
    else liste.current?.focus({ preventScroll: true })
  }

  function schliessen(fokusZurueck: boolean) {
    try {
      panel.current?.hidePopover()
    } catch {
      // schon zu
    }
    // Selbst geschlossen (Wahl, Escape) — der nächste Klick auf den Knopf
    // soll wieder öffnen; die Sperre gilt nur für „daneben geklickt".
    geschlossenUm.current = 0
    if (fokusZurueck) knopf.current?.focus({ preventScroll: true })
  }

  function waehlen(o: AuswahlOption | undefined) {
    if (!o || o.deaktiviert) return
    geaendert.current = true
    setUngueltig(false)
    if (multiple) {
      const neu = gewaehlt.includes(o.wert) ? gewaehlt.filter((w) => w !== o.wert) : [...gewaehlt, o.wert]
      // Reihenfolge wie in der Liste, damit das Formular stabil bleibt.
      setEigen(optionen.filter((x) => neu.includes(x.wert)).map((x) => x.wert))
      return
    }
    if (!gesteuert) setEigen(o.wert)
    if (o.wert !== wert) onAuswahl?.(o.wert)
    schliessen(true)
  }

  function knopfTasten(e: KeyboardEvent<HTMLButtonElement>) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      oeffnen()
    } else if (mitSuche && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      oeffnen(e.key)
    }
  }

  function panelTasten(e: KeyboardEvent<HTMLDivElement>) {
    const n = treffer.length
    const springe = (ziel: number, schritt: number) => {
      const i = ersteFreie(treffer, Math.min(Math.max(ziel, 0), n - 1), schritt)
      if (i >= 0) setAktiv(i)
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        springe(aktiv + 1, 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        springe(aktiv - 1, -1)
        break
      case 'PageDown':
        e.preventDefault()
        springe(aktiv + 10, 1)
        break
      case 'PageUp':
        e.preventDefault()
        springe(aktiv - 10, -1)
        break
      case 'Enter':
        e.preventDefault()
        waehlen(treffer[aktiv])
        break
      case ' ':
        // Leertaste gehört dem Suchfeld; ohne Suchfeld wählt sie.
        if (!mitSuche) {
          e.preventDefault()
          waehlen(treffer[aktiv])
        }
        break
      case 'Escape':
        e.preventDefault()
        schliessen(true)
        break
      case 'Tab':
        schliessen(false)
        break
    }
  }

  const gewaehlteOptionen = optionen.filter((o) => gewaehlt.includes(o.wert))
  const anzeige = multiple
    ? gewaehlteOptionen.map((o) => o.text).join(', ')
    : (gewaehlteOptionen[0]?.text ?? '')
  const leer = multiple ? gewaehlt.length === 0 : !gewaehlt[0]
  const aktiveId = treffer[aktiv] ? `${basisId}-o${aktiv}` : undefined

  let letzteGruppe: string | undefined

  return (
    <span ref={huelle} className="auswahl" style={style}>
      <button
        ref={knopf}
        type="button"
        id={id}
        className={`auswahl-knopf${className ? ` ${className}` : ''}`}
        title={title ?? (anzeige || undefined)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={offen}
        aria-controls={panelId}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || ungueltig || undefined}
        // Greift nur, solange React noch nicht übernommen hat (langsames
        // Netz): dann öffnet der Browser die Liste selbst.
        popoverTarget={panelId}
        onKeyDown={knopfTasten}
        onClick={(e) => {
          // Nach der Hydrierung steuern wir selbst (Lage, Fokus im selben Klick).
          e.preventDefault()
          const p = panel.current
          if (p?.matches(':popover-open')) schliessen(true)
          // Derselbe Klick hat die Liste eben per „daneben geklickt" geschlossen.
          else if (performance.now() - geschlossenUm.current > 300) oeffnen()
        }}
      >
        <span className={`auswahl-text${leer && !anzeige ? ' leer' : ''}`}>
          {anzeige || placeholder || 'Auswählen …'}
        </span>
        <span className="auswahl-pfeil" aria-hidden="true" />
      </button>

      {name &&
        gewaehlt.map((w) => <input key={w} type="hidden" name={name} value={w} disabled={disabled} />)}
      {required && (
        <input
          className="auswahl-pruef"
          tabIndex={-1}
          aria-hidden="true"
          required
          disabled={disabled}
          value={leer ? '' : 'gewählt'}
          onChange={() => {}}
          onInvalid={() => setUngueltig(true)}
        />
      )}

      {/* Klicks in der Liste dürfen das umgebende <label> nicht auslösen
          (das würde den Knopf erneut drücken) und keine Zeilen-Links. */}
      <div
        ref={panel}
        id={panelId}
        popover="auto"
        className="auswahl-panel"
        onKeyDown={panelTasten}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {mitSuche && (
          <input
            ref={suche}
            className="auswahl-suche"
            type="search"
            placeholder="Suchen …"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={offen}
            aria-controls={`${panelId}-box`}
            aria-activedescendant={aktiveId}
            aria-autocomplete="list"
            value={eingabe}
            onChange={(e) => {
              setEingabe(e.target.value)
              setAktiv(Math.max(0, ersteFreie(filtern(optionen, e.target.value).treffer)))
            }}
          />
        )}
        <div
          ref={liste}
          id={`${panelId}-box`}
          role="listbox"
          tabIndex={-1}
          aria-multiselectable={multiple || undefined}
          aria-activedescendant={mitSuche ? undefined : aktiveId}
          aria-label={ariaLabel}
          className="auswahl-liste"
        >
          {offen &&
            treffer.map((o, i) => {
              const kopf = o.gruppe && o.gruppe !== letzteGruppe ? o.gruppe : null
              letzteGruppe = o.gruppe
              const istGewaehlt = gewaehlt.includes(o.wert)
              return (
                <Fragment key={`${o.wert}-${i}`}>
                  {kopf && (
                    <div className="auswahl-gruppe" role="presentation">
                      {kopf}
                    </div>
                  )}
                  <div
                    id={`${basisId}-o${i}`}
                    data-index={i}
                    role="option"
                    tabIndex={-1}
                    aria-selected={istGewaehlt}
                    aria-disabled={o.deaktiviert || undefined}
                    className={`auswahl-option${i === aktiv ? ' aktiv' : ''}${istGewaehlt ? ' gewaehlt' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i !== aktiv && !o.deaktiviert && setAktiv(i)}
                    onClick={() => waehlen(o)}
                  >
                    {multiple && <span className="auswahl-haken" aria-hidden="true" />}
                    <span className={o.wert === '' ? 'muted' : undefined}>{o.text || '—'}</span>
                  </div>
                </Fragment>
              )
            })}
          {offen && treffer.length === 0 && <div className="auswahl-hinweis">Kein Treffer für „{eingabe}"</div>}
          {offen && mehr > 0 && (
            <div className="auswahl-hinweis">… {mehr} weitere — Suche eingrenzen</div>
          )}
        </div>
        {multiple && offen && (
          <div className="auswahl-fuss">
            <span className="muted small">{gewaehlt.length} gewählt</span>
            <button type="button" className="small" onClick={() => schliessen(true)}>
              Fertig
            </button>
          </div>
        )}
      </div>
    </span>
  )
}
