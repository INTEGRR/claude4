/**
 * Verbindung für Wartungsskripte (Migration, Seed).
 *
 * Die Anwendung selbst läuft auf einer zustandslosen Umgebung über den
 * Transaction-Pooler (Supabase, Port 6543). Der kennt keine Sitzung: jede
 * Anweisung kann auf einer anderen Verbindung landen. Für Schemaänderungen
 * und den Seed ist das die falsche Ebene — beides braucht eine echte Sitzung.
 *
 * Deshalb: liegt DIRECT_URL vor, nehmen die Skripte die; sonst DATABASE_URL.
 * Im Docker-Betrieb und lokal ist beides dasselbe, dort ist nichts zu setzen.
 */
export function wartungsUrl(): string {
  const quelle = process.env.DIRECT_URL ? 'DIRECT_URL' : 'DATABASE_URL'
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')

  // Früh und verständlich scheitern: „Invalid URL" aus dem Treiber verrät
  // nicht, WAS faul ist. Häufige Unfälle: Platzhalter wie <HOST> stehen noch
  // drin, Anführungszeichen um den Wert, oder der Variablenname wurde mit
  // ins Wertefeld kopiert.
  let geparst: URL
  try {
    geparst = new URL(url)
  } catch {
    const hinweis = url.includes('<') || url.includes('>')
      ? 'Da steht noch ein Platzhalter in spitzen Klammern drin.'
      : url.startsWith('"') || url.startsWith("'")
        ? 'Der Wert ist in Anführungszeichen eingeschlossen — die müssen weg.'
        : /^\s*DATABASE_URL=|^\s*DIRECT_URL=/.test(url)
          ? 'Der Variablenname wurde mit ins Wertefeld kopiert.'
          : 'Erwartet wird postgres://benutzer:passwort@host:port/datenbank.'
    throw new Error(
      `${quelle} ist keine gültige Verbindungszeichenfolge. ${hinweis} ` +
        `Aktueller Wert beginnt mit: ${JSON.stringify(url.slice(0, 30))}…`,
    )
  }
  if (!/^postgres(ql)?:$/.test(geparst.protocol)) {
    throw new Error(`${quelle} muss mit postgres:// beginnen (ist: ${geparst.protocol}//…)`)
  }
  return url
}
