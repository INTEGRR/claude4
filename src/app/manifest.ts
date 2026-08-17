import type { MetadataRoute } from 'next'

/**
 * Web-App-Manifest: das ERP lässt sich als App installieren („Zum
 * Startbildschirm hinzufügen" / Installieren-Knopf in Chrome und Edge) und
 * läuft dann randlos ohne Browserleiste — auf dem Packtisch-Tablet und dem
 * Telefon fühlt es sich nativ an. Bewusst OHNE Service-Worker-Caching: ein
 * ERP soll live Daten zeigen, nie einen alten Bestand aus dem Cache.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'erp.system',
    short_name: 'erp.system',
    description: 'Prozess-ERP: Verkauf, Fertigung, Einkauf, Lager, Versand',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f4f2ed',
    theme_color: '#f4f2ed',
    lang: 'de',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
