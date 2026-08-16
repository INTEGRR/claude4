/**
 * Modul-Auflösung für Prozesstests unter blankem Node (ohne Next.js-Build):
 *
 *  - `@/…` ist der tsconfig-Alias auf src/ — Node kennt ihn nicht, hier wird
 *    er auf Dateipfade abgebildet (mit .ts-Endung, wie es
 *    --experimental-strip-types verlangt).
 *  - `server-only` ist kein installiertes Paket, sondern wird von Next.js
 *    intern bereitgestellt. Unter Node wird es zum leeren Modul — die
 *    Schutzwirkung (nicht in Client-Bundles) betrifft nur den Next-Build.
 *  - Relative Importe ohne Endung (`./dhl`) sind im App-Code üblich (Next
 *    löst sie auf), --experimental-strip-types verlangt aber volle Pfade.
 *    Schlägt die normale Auflösung fehl, wird `.ts`/`.tsx` nachprobiert.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const LEERES_MODUL = 'data:text/javascript,export%20default%20undefined'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { url: LEERES_MODUL, shortCircuit: true }
  }

  if (specifier.startsWith('@/')) {
    const basis = path.join(SRC, specifier.slice(2))
    for (const kandidat of [basis, `${basis}.ts`, `${basis}.tsx`, path.join(basis, 'index.ts')]) {
      if (existsSync(kandidat)) {
        return nextResolve(pathToFileURL(kandidat).href, context)
      }
    }
    throw new Error(`Alias nicht auflösbar: ${specifier} (gesucht unter ${basis})`)
  }

  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith('file:')
  ) {
    try {
      return await nextResolve(specifier, context)
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') {
        throw err
      }
      const basis = fileURLToPath(new URL(specifier, context.parentURL))
      for (const kandidat of [`${basis}.ts`, `${basis}.tsx`, path.join(basis, 'index.ts')]) {
        if (existsSync(kandidat)) {
          return nextResolve(pathToFileURL(kandidat).href, context)
        }
      }
      throw err
    }
  }

  return nextResolve(specifier, context)
}
