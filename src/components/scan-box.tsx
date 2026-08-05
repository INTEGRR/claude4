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

  return (
    <form onSubmit={submit} className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {error && <span className="badge danger">{error}</span>}
      <input
        ref={inputRef}
        type="search"
        placeholder="Barcode scannen oder suchen (F2)"
        aria-label="Barcode scannen"
        style={{ width: 280 }}
        disabled={busy}
      />
    </form>
  )
}
