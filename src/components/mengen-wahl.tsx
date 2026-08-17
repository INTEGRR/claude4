'use client'
import { useRef } from 'react'

/**
 * Mengenfeld mit begründeten Alternativen — die Beschaffung hebt nichts stumm
 * an: die Empfehlung steht im Feld, die Chips (berechneter Bedarf, MOQ,
 * günstigere Staffelgrenzen) setzen die Menge per Klick, entschieden wird
 * beim Absenden des umgebenden Formulars.
 */
export function MengenWahl({
  name = 'menge',
  vorgabe,
  optionen,
}: {
  name?: string
  vorgabe: number
  optionen: { menge: number; label: string; hinweis?: string }[]
}) {
  const feld = useRef<HTMLInputElement>(null)
  return (
    <div>
      <input
        ref={feld}
        type="number"
        name={name}
        step="0.001"
        min="0.001"
        defaultValue={vorgabe}
        className="num"
        style={{ width: 96 }}
      />
      {optionen.length > 0 && (
        <div className="actions" style={{ marginTop: 4, gap: 4 }}>
          {optionen.map((o) => (
            <button
              key={o.label}
              type="button"
              className="small"
              title={o.hinweis}
              onClick={() => {
                if (feld.current) feld.current.value = String(o.menge)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
