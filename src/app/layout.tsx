import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { themeBootScript } from '@/components/theme-toggle'
import './globals.css'

export const metadata: Metadata = {
  title: 'ERP',
  description: 'Verkauf, Fertigung, Einkauf, Lager, Versand',
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
