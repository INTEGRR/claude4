import { redirect } from 'next/navigation'

/**
 * Die Stammdaten-Konfiguration ist am 2026-09-26 in die Einstellungen
 * gezogen (Entscheidungslog) — diese Adresse bleibt als Weiterleitung, damit
 * Lesezeichen und alte Links nicht ins Leere laufen.
 */
export default function KonfigurationWeiterleitung(): never {
  redirect('/einstellungen/stammdaten')
}
