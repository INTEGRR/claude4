import { DRIVE_SCOPE, googleFake, zugriffstoken } from './auth.ts'

/**
 * Google Drive über REST (0092) — alles in der geteilten Ablage „Einkauf",
 * deshalb überall supportsAllDrives. Echte Anbindung und Attrappe
 * (GOOGLE_FAKE=1, google-fake.ts) teilen dieselbe Schnittstelle; wer sie
 * nutzt, holt sie über `drive()`.
 */

export interface DriveDatei {
  id: string
  name: string
  mimeType: string
  size?: string
  md5Checksum?: string
  parents?: string[]
  webViewLink?: string
}

export interface StueckErgebnis {
  fertig: boolean
  /** Bei fertig: die angelegte Datei. */
  datei?: DriveDatei
  /** Sonst: ab welchem Byte es weitergeht (was Google bestätigt hat). */
  weiterAb?: number
}

export interface DriveApi {
  ordnerFinden(name: string, elternId: string): Promise<string | null>
  ordnerAnlegen(name: string, elternId: string): Promise<string>
  uploadSitzungAnlegen(p: { name: string; mime: string; groesse: number; elternId: string }): Promise<string>
  uploadStueck(sessionUri: string, bytes: Uint8Array, start: number, gesamt: number): Promise<StueckErgebnis>
  dateiLesen(fileId: string): Promise<DriveDatei>
  dateiHochladen(p: { name: string; mime: string; bytes: Uint8Array; elternId: string }): Promise<DriveDatei>
  dateiInhalt(fileId: string): Promise<Uint8Array>
  /** Hängt die Datei in einen anderen Ordner um (alle bisherigen Eltern werden gelöst). */
  dateiVerschieben(fileId: string, zielId: string): Promise<void>
}

export const ORDNER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FELDER = 'id,name,mimeType,size,md5Checksum,parents,webViewLink'

/** Link zum Öffnen im Browser (in der Attrappe: die lokale Ausgabe-Route). */
export function driveLink(fileId: string): string {
  return googleFake() ? `/api/google-fake/datei/${fileId}` : `https://drive.google.com/file/d/${fileId}/view`
}

async function protokoll(kind: string, ok: boolean, statusCode: number | null, fehler?: string, reference?: string) {
  // Dynamisch: das Protokoll braucht die Datenbank, die reine Drive-Logik nicht.
  const { logTransaction } = await import('../integrationen/transaktionen.ts')
  await logTransaction({ system: 'google', kind, reference, ok, statusCode, error: fehler ?? null })
}

async function anfrage(url: string, init: RequestInit & { art: string; referenz?: string }): Promise<Response> {
  const token = await zugriffstoken(DRIVE_SCOPE)
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok && res.status !== 308) {
    const text = await res.text().catch(() => '')
    const meldung = (() => {
      try {
        return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 300)
      } catch {
        return text.slice(0, 300)
      }
    })()
    await protokoll(init.art, false, res.status, meldung, init.referenz)
    throw new Error(`Google Drive (${init.art}): ${res.status} ${meldung}`)
  }
  return res
}

const echteAblage: DriveApi = {
  async ordnerFinden(name, elternId) {
    const q = [
      `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
      `'${elternId}' in parents`,
      `mimeType = '${ORDNER_MIME}'`,
      'trashed = false',
    ].join(' and ')
    const url = `${API}/files?${new URLSearchParams({
      q,
      fields: 'files(id,name)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      pageSize: '10',
    })}`
    const res = await anfrage(url, { method: 'GET', art: 'drive.ordner_finden' })
    const daten = (await res.json()) as { files?: { id: string }[] }
    return daten.files?.[0]?.id ?? null
  },

  async ordnerAnlegen(name, elternId) {
    const res = await anfrage(`${API}/files?supportsAllDrives=true&fields=id`, {
      method: 'POST',
      art: 'drive.ordner_anlegen',
      referenz: name,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: ORDNER_MIME, parents: [elternId] }),
    })
    const daten = (await res.json()) as { id: string }
    await protokoll('drive.ordner_anlegen', true, res.status, undefined, name)
    return daten.id
  },

  async uploadSitzungAnlegen({ name, mime, groesse, elternId }) {
    const res = await anfrage(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FELDER}`, {
      method: 'POST',
      art: 'drive.upload_sitzung',
      referenz: name,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mime,
        'x-upload-content-length': String(groesse),
      },
      body: JSON.stringify({ name, mimeType: mime, parents: [elternId] }),
    })
    const ort = res.headers.get('location')
    if (!ort) throw new Error('Google Drive hat keine Upload-Adresse geliefert')
    await protokoll('drive.upload_sitzung', true, res.status, undefined, name)
    return ort
  },

  async uploadStueck(sessionUri, bytes, start, gesamt) {
    // Die Sitzungsadresse selbst ist die Berechtigung — kein Token nötig.
    const ende = start + bytes.byteLength - 1
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'content-length': String(bytes.byteLength),
        'content-range': `bytes ${start}-${ende}/${gesamt}`,
      },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(55_000),
    })
    if (res.status === 308) {
      const bereich = res.headers.get('range')
      const bestaetigt = bereich ? Number(bereich.split('-')[1]) + 1 : 0
      return { fertig: false, weiterAb: bestaetigt }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      await protokoll('drive.upload_stueck', false, res.status, text.slice(0, 300))
      throw new Error(`Google Drive (Upload): ${res.status} ${text.slice(0, 200)}`)
    }
    return { fertig: true, datei: (await res.json()) as DriveDatei }
  },

  async dateiLesen(fileId) {
    const res = await anfrage(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${FELDER}`, {
      method: 'GET',
      art: 'drive.datei_lesen',
      referenz: fileId,
    })
    return (await res.json()) as DriveDatei
  },

  async dateiHochladen({ name, mime, bytes, elternId }) {
    // Multipart trägt bei Google nur bis 5 MB — größere Mail-Anhänge (bis
    // 25 MB) gehen als fortsetzbarer Upload in einem einzigen Stück.
    if (bytes.byteLength > 5 * 1024 * 1024) {
      const uri = await this.uploadSitzungAnlegen({ name, mime, groesse: bytes.byteLength, elternId })
      const r = await this.uploadStueck(uri, bytes, 0, bytes.byteLength)
      if (!r.fertig || !r.datei) throw new Error(`Google Drive (Upload): unvollständig bei ${r.weiterAb ?? 0} Bytes`)
      return r.datei
    }
    const grenze = `krnl-${crypto.randomUUID()}`
    const kopf = Buffer.from(
      `--${grenze}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
        name,
        mimeType: mime,
        parents: [elternId],
      })}\r\n--${grenze}\r\ncontent-type: ${mime}\r\n\r\n`,
    )
    const fuss = Buffer.from(`\r\n--${grenze}--`)
    const res = await anfrage(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${FELDER}`, {
      method: 'POST',
      art: 'drive.datei_hochladen',
      referenz: name,
      headers: { 'content-type': `multipart/related; boundary=${grenze}` },
      body: Buffer.concat([kopf, Buffer.from(bytes), fuss]),
    })
    await protokoll('drive.datei_hochladen', true, res.status, undefined, name)
    return (await res.json()) as DriveDatei
  },

  async dateiInhalt(fileId) {
    const res = await anfrage(`${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      method: 'GET',
      art: 'drive.datei_inhalt',
      referenz: fileId,
    })
    return new Uint8Array(await res.arrayBuffer())
  },

  async dateiVerschieben(fileId, zielId) {
    const datei = await this.dateiLesen(fileId)
    const alt = (datei.parents ?? []).filter((e) => e !== zielId)
    if (alt.length === 0 && datei.parents?.includes(zielId)) return
    const q = new URLSearchParams({ supportsAllDrives: 'true', addParents: zielId, fields: 'id' })
    if (alt.length) q.set('removeParents', alt.join(','))
    await anfrage(`${API}/files/${encodeURIComponent(fileId)}?${q}`, {
      method: 'PATCH',
      art: 'drive.datei_verschieben',
      referenz: fileId,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: '{}',
    })
    await protokoll('drive.datei_verschieben', true, 200, undefined, fileId)
  },
}

/** Die Drive-Anbindung — echt oder Attrappe, je nach GOOGLE_FAKE. */
export async function drive(): Promise<DriveApi> {
  if (googleFake()) {
    const { fakeDrive } = await import('./google-fake.ts')
    return fakeDrive
  }
  return echteAblage
}
