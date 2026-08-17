import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { themeBootScript } from '@/components/theme-toggle'
import './globals.css'

export const metadata: Metadata = {
  title: 'KRNL',
  description: 'Enterprise Resource Kernel — Verkauf, Fertigung, Einkauf, Lager, Versand, Finanzen',
  // PWA: installierbar, auf iOS randlos als Web-App vom Startbildschirm.
  appleWebApp: {
    capable: true,
    title: 'KRNL',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  // Safe-Area-Werte (Gestenleiste, Notch) sind nur mit cover verfügbar —
  // die Sidebar polstert damit ihr „Abmelden" (BUG/00007).
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f2ed' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a1a' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Setzt das Theme vor dem ersten Anstrich — sonst blitzt die
            falsche Helligkeit kurz auf. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
