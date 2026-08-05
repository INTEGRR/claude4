/** Lädt .env für CLI-Skripte (Next.js macht das im Server selbst). */
import { existsSync } from 'node:fs'

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) {
    process.loadEnvFile(file)
    break
  }
}
