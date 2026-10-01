import { redirect } from 'next/navigation'

/**
 * Der Packtisch ist im EINEN Scanfeld aufgegangen (Entscheidungslog
 * 2026-10-01): ein gescannter Packzettel startet dort den Packablauf.
 * Die Adresse bleibt für Lesezeichen erhalten.
 */
export default function PacktischPage() {
  redirect('/scanner')
}
