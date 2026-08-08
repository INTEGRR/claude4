'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

/**
 * Scan-Feld für Handscanner (Keyboard-Wedge): Beleg- oder Produktbarcode
 * scannen, Enter kommt vom Gerät. F2 oder Strg+K springt ins Feld.
 */
export function ScanBox() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && e.key === 'k')) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const code = inputRef.current?.value.trim()
    if (!code) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scan?code=${encodeURIComponent(code)}`)
      const data = (await res.json()) as { url?: string; error?: string }
      if (data.url) {
        if (inputRef.current) inputRef.current.value = ''
        router.push(data.url)
      } else {
        setError(data.error ?? 'Unbekannter Code')
        inputRef.current?.select()
      }
    } catch {
      setError('Suche fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  // Zustand des Scanners als Leuchte plus Wort. Alle drei Wörter sind
  // gleich lang, damit die Kopfzeile beim Wechsel nicht in der Breite springt.
  const zustand = error
    ? { led: 'led warn', wort: 'Fehler' }
    : busy
      ? { led: 'led on', wort: 'Suche' }
      : { led: 'led ok', wort: 'Bereit' }

  return (
    <form onSubmit={submit} className="no-print actions scan-form">
      <span className="mono-label scan-zustand">
        <span className={zustand.led} />
        {zustand.wort}
      </span>
      {/* Barcodes sind Codes: Monospace, damit 0/O und 1/l unterscheidbar bleiben. */}
      <input
        ref={inputRef}
        type="search"
        className="mono"
        placeholder="Barcode scannen oder suchen"
        aria-label="Barcode scannen"
        disabled={busy}
      />
      {/* Der Tastaturhinweis ist auf dem Telefon sinnlos — CSS blendet ihn aus. */}
      <span className="mono-label scan-taste">F2</span>
      {/* Meldung rechts vom Feld: die Eingabe bleibt stehen, wenn ein Scan
          fehlschlägt. Breite gedeckelt, der volle Text steht im Titel. */}
      {error && (
        <span className="small scan-fehler" role="alert" title={error}>
          {error}
        </span>
      )}
    </form>
  )
}
