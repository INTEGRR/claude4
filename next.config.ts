import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Schlankes Docker-Image: nur die tatsächlich genutzten Module werden
  // gebündelt. Auf Vercel wäre das falsch — dort schnürt die Plattform die
  // Funktionen selbst, und `standalone` würde ihr dazwischenfunken.
  output: process.env.VERCEL ? undefined : 'standalone',
  serverExternalPackages: ['postgres', 'bwip-js'],
  experimental: {
    // Alle Änderungen laufen über Server Actions; das Limit ist großzügig
    // gewählt, weil Label-PDFs von DHL durchgereicht werden.
    serverActions: { bodySizeLimit: '8mb' },
  },
}

export default nextConfig
