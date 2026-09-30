import { createHash, randomUUID } from 'node:crypto'
import type { DriveApi, DriveDatei } from './drive.ts'
import { ORDNER_MIME } from './drive.ts'

/**
 * Google-Attrappe (GOOGLE_FAKE=1) für Prozesstests, Staging und den
 * lokalen Browsertest: eine Ablage im Speicher des Prozesses (auf
 * globalThis, damit sie Modul-Neuladen übersteht). Die Upload-Sitzung ist
 * eine interne Adresse; die Stücke landen im Speicher, am Ende entsteht die
 * Datei mit echtem md5 — damit prüft KRNL genau wie gegen Google.
 */

interface FakeDatei extends DriveDatei {
  bytes: Buffer
}

interface FakeSitzung {
  name: string
  mime: string
  groesse: number
  elternId: string
  teile: Buffer[]
  empfangen: number
}

interface FakeAblage {
  dateien: Map<string, FakeDatei>
  sitzungen: Map<string, FakeSitzung>
}

const ablage = (): FakeAblage => {
  const g = globalThis as unknown as { __krnlDriveFake?: FakeAblage }
  g.__krnlDriveFake ??= { dateien: new Map(), sitzungen: new Map() }
  return g.__krnlDriveFake
}

/** Für Tests: Attrappe leeren. */
export function fakeDriveLeeren(): void {
  ablage().dateien.clear()
  ablage().sitzungen.clear()
}

/** Für Tests und die Ausgabe-Route: eine Datei samt Inhalt. */
export function fakeDatei(id: string): FakeDatei | undefined {
  return ablage().dateien.get(id)
}

function anlegen(name: string, mime: string, elternId: string, bytes: Buffer): FakeDatei {
  const id = `fake-${randomUUID()}`
  const datei: FakeDatei = {
    id,
    name,
    mimeType: mime,
    size: String(bytes.byteLength),
    md5Checksum: mime === ORDNER_MIME ? undefined : createHash('md5').update(bytes).digest('hex'),
    parents: [elternId],
    webViewLink: `/api/google-fake/datei/${id}`,
    bytes,
  }
  ablage().dateien.set(id, datei)
  return datei
}

const ohneInhalt = ({ bytes: _b, ...rest }: FakeDatei): DriveDatei => rest

export const fakeDrive: DriveApi = {
  async ordnerFinden(name, elternId) {
    for (const d of ablage().dateien.values()) {
      if (d.mimeType === ORDNER_MIME && d.name === name && d.parents?.includes(elternId)) return d.id
    }
    return null
  },

  async ordnerAnlegen(name, elternId) {
    return anlegen(name, ORDNER_MIME, elternId, Buffer.alloc(0)).id
  },

  async uploadSitzungAnlegen({ name, mime, groesse, elternId }) {
    const uri = `fake://upload/${randomUUID()}`
    ablage().sitzungen.set(uri, { name, mime, groesse, elternId, teile: [], empfangen: 0 })
    return uri
  },

  async uploadStueck(sessionUri, bytes, start, gesamt) {
    const s = ablage().sitzungen.get(sessionUri)
    if (!s) throw new Error('Google Drive (Upload): 404 Sitzung unbekannt oder abgelaufen')
    if (start !== s.empfangen) return { fertig: false, weiterAb: s.empfangen }
    if (gesamt !== s.groesse) throw new Error('Google Drive (Upload): 400 Gesamtgröße passt nicht')
    s.teile.push(Buffer.from(bytes))
    s.empfangen += bytes.byteLength
    if (s.empfangen < s.groesse) return { fertig: false, weiterAb: s.empfangen }
    ablage().sitzungen.delete(sessionUri)
    return { fertig: true, datei: ohneInhalt(anlegen(s.name, s.mime, s.elternId, Buffer.concat(s.teile))) }
  },

  async dateiLesen(fileId) {
    const d = ablage().dateien.get(fileId)
    if (!d) throw new Error(`Google Drive (drive.datei_lesen): 404 File not found: ${fileId}`)
    return ohneInhalt(d)
  },

  async dateiHochladen({ name, mime, bytes, elternId }) {
    return ohneInhalt(anlegen(name, mime, elternId, Buffer.from(bytes)))
  },

  async dateiInhalt(fileId) {
    const d = ablage().dateien.get(fileId)
    if (!d) throw new Error(`Google Drive (drive.datei_inhalt): 404 File not found: ${fileId}`)
    return new Uint8Array(d.bytes)
  },
}
