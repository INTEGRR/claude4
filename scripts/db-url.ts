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
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  return url
}
