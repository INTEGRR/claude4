import type { MetadataRoute } from 'next'

/**
 * Web-App-Manifest: die App installiert sich als „KRNL" — Name, dunkle
 * Startfarbe und Icon speisen den NATIVEN Startbildschirm der PWA, der vor
 * unserem eigenen Splash steht. Beide teilen sich das Void-Schwarz des
 * Designs, damit der Übergang nahtlos ist. Bewusst OHNE Service-Worker-
 * Caching: ein ERP zeigt live Daten, nie einen alten Bestand aus dem Cache.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KRNL',
    short_name: 'KRNL',
    description: 'Enterprise Resource Kernel — Verkauf, Fertigung, Einkauf, Lager, Versand, Finanzen',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#08090a',
    theme_color: '#08090a',
    lang: 'de',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
