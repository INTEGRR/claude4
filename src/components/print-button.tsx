'use client'

export function PrintButton({ label = 'Drucken' }: { label?: string }) {
  return (
    <button className="primary" type="button" onClick={() => window.print()}>
      {label}
    </button>
  )
}
