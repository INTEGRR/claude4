'use client'
import { useRef, useState } from 'react'

/**
 * Originaldarstellung einer Mail (0093): lädt das HTML erst auf Klick und
 * zeigt es in einem iframe ohne Skripte. Die eingebettete CSP sperrt alles
 * von außen — Tracking-Pixel und Fremdbilder laden nicht, Links öffnen in
 * einem neuen Tab. `allow-same-origin` ohne `allow-scripts` erlaubt nur,
 * die Höhe von außen zu messen.
 */
const KOPF =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: cid:; style-src \'unsafe-inline\'; font-src data:">' +
  '<base target="_blank"><style>body{font:14px/1.45 system-ui,sans-serif;margin:8px;color:#111;background:#fff;word-break:break-word}img{max-width:100%;height:auto}</style>'

export function MailHtml({ nachrichtId }: { nachrichtId: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [laedt, setLaedt] = useState(false)
  const rahmen = useRef<HTMLIFrameElement>(null)

  async function laden() {
    setLaedt(true)
    setFehler(null)
    try {
      const res = await fetch(`/api/einkauf/mail-html/${nachrichtId}`)
      if (!res.ok) throw new Error('Die Originaldarstellung ist nicht verfügbar.')
      setHtml(await res.text())
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err))
    } finally {
      setLaedt(false)
    }
  }

  function anpassen() {
    const doc = rahmen.current?.contentDocument
    if (doc && rahmen.current) rahmen.current.style.height = `${Math.min(doc.documentElement.scrollHeight + 16, 1400)}px`
  }

  if (html === null) {
    return (
      <div className="mail-html-knopf">
        <button type="button" className="small" onClick={laden} disabled={laedt}>
          {laedt ? 'Lädt …' : 'Originaldarstellung (HTML)'}
        </button>
        {fehler && <span className="muted small"> {fehler}</span>}
      </div>
    )
  }
  return (
    <div className="mail-html">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="muted small">Originaldarstellung — externe Bilder gesperrt</span>
        <button type="button" className="small" onClick={() => setHtml(null)}>
          Schließen
        </button>
      </div>
      <iframe
        ref={rahmen}
        title="Originaldarstellung der Mail"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={KOPF + html}
        onLoad={anpassen}
        style={{ width: '100%', height: 240, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
      />
    </div>
  )
}
