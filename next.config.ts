import type { NextConfig } from 'next'

/**
 * Sicherheits-Header für jede Antwort (Sicherheitscheck vor dem Go-Live,
 * Entscheidungslog 2026-09-18). HSTS setzt Vercel bereits; im Docker-Betrieb
 * gehört es an den TLS-Endpunkt (Caddy/Traefik), nicht in die Anwendung.
 * Kein Content-Security-Policy-Header: react-pdf, React Flow und die
 * Inline-Styles der Masken bräuchten eine gepflegte Ausnahmeliste — das
 * ist ein eigenes Vorhaben, keine Nebenbei-Zeile.
 */
const SICHERHEITS_HEADER = [
  // Das ERP gehört in kein fremdes iframe — schließt Clickjacking aus.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Mikrofon für Diktat und Sprachmodus, sonst nichts.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=()' },
]

const nextConfig: NextConfig = {
  // Schlankes Docker-Image: nur die tatsächlich genutzten Module werden
  // gebündelt. Auf Vercel wäre das falsch — dort schnürt die Plattform die
  // Funktionen selbst, und `standalone` würde ihr dazwischenfunken.
  output: process.env.VERCEL ? undefined : 'standalone',
  // Der Framework-Name gehört nicht in jede Antwort.
  poweredByHeader: false,
  // @react-pdf/renderer: als externes Paket laden — gebündelt stolpert
  // sein Yoga-Layout (WASM) im Serverless-Build.
  serverExternalPackages: ['postgres', 'bwip-js', '@react-pdf/renderer'],
  experimental: {
    // Alle Änderungen laufen über Server Actions; das Limit ist großzügig
    // gewählt, weil Label-PDFs von DHL durchgereicht werden.
    serverActions: { bodySizeLimit: '8mb' },
  },
  async headers() {
    return [{ source: '/(.*)', headers: SICHERHEITS_HEADER }]
  },
}

export default nextConfig
