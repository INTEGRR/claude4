'use client'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'
import { dokumentAendern, dokumentLoesen, dokumentRegistrieren, uploadVorbereiten } from '@/app/(erp)/einkauf/dokumente-actions'
import { DOKUMENT_ARTEN, type DokumentArt, type DokumentModell } from '@/modules/einkauf/dokument-modelle'
import { isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Hochladen in die Google-Ablage (0092): Datei wählen oder hineinziehen →
 * einkauf.upload_vorbereiten → Stücke à 4 MiB an /api/dokumente/stueck →
 * einkauf.dokument_registrieren. Mehrere Dateien nacheinander, je Datei ein
 * Fortschrittsbalken; bricht ein Stück ab, bleibt die Meldung stehen.
 */

interface Lauf {
  name: string
  prozent: number
  fehler?: string
  fertig?: boolean
}

async function hochladen(
  datei: File,
  modell: DokumentModell,
  recordId: string,
  fortschritt: (p: number) => void,
): Promise<void> {
  const vorb = await uploadVorbereiten({
    name: datei.name,
    mime: datei.type || undefined,
    groesse: datei.size,
    modell,
    record_id: recordId,
  })
  if (isActionError(vorb)) throw new Error(vorb.error)
  const daten = (isActionInfo(vorb) ? vorb.daten : undefined) as
    | { sitzung_id: string; stueck_bytes: number }
    | undefined
  if (!daten) throw new Error('Upload konnte nicht beginnen')

  let start = 0
  let dateiId: string | undefined
  let versuche = 0
  while (!dateiId) {
    const ende = Math.min(start + daten.stueck_bytes, datei.size)
    const res = await fetch(`/api/dokumente/stueck?sitzung=${daten.sitzung_id}&start=${start}`, {
      method: 'POST',
      body: datei.slice(start, ende),
    })
    const antwort = (await res.json().catch(() => ({}))) as {
      fertig?: boolean
      drive_file_id?: string
      weiter_ab?: number
      error?: string
    }
    if (!res.ok) {
      // Netzwacklern verzeihen: dasselbe Stück bis zu dreimal.
      if (++versuche <= 3 && res.status >= 500) continue
      throw new Error(antwort.error ?? `Upload fehlgeschlagen (${res.status})`)
    }
    versuche = 0
    if (antwort.fertig) dateiId = antwort.drive_file_id
    else start = antwort.weiter_ab ?? ende
    fortschritt(Math.min(99, Math.round((100 * (antwort.fertig ? datei.size : start)) / datei.size)))
  }

  const reg = await dokumentRegistrieren({ sitzung_id: daten.sitzung_id, drive_file_id: dateiId }, modell, recordId)
  if (isActionError(reg)) throw new Error(reg.error)
  fortschritt(100)
}

export function DokumentUpload({ modell, recordId }: { modell: DokumentModell; recordId: string }) {
  const router = useRouter()
  const eingabe = useRef<HTMLInputElement>(null)
  const [laeufe, setLaeufe] = useState<Lauf[]>([])
  const [ueber, setUeber] = useState(false)
  const [aktiv, setAktiv] = useState(false)

  async function alle(dateien: File[]) {
    if (dateien.length === 0 || aktiv) return
    setAktiv(true)
    setLaeufe(dateien.map((d) => ({ name: d.name, prozent: 0 })))
    for (const [i, datei] of dateien.entries()) {
      const setzen = (teil: Partial<Lauf>) =>
        setLaeufe((l) => l.map((x, j) => (j === i ? { ...x, ...teil } : x)))
      try {
        await hochladen(datei, modell, recordId, (prozent) => setzen({ prozent }))
        setzen({ fertig: true, prozent: 100 })
      } catch (err) {
        setzen({ fehler: err instanceof Error ? err.message : 'Upload fehlgeschlagen' })
      }
    }
    setAktiv(false)
    router.refresh()
  }

  return (
    <div
      className={`dok-upload${ueber ? ' ueber' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setUeber(true)
      }}
      onDragLeave={() => setUeber(false)}
      onDrop={(e) => {
        e.preventDefault()
        setUeber(false)
        void alle([...e.dataTransfer.files])
      }}
    >
      <div className="actions" style={{ gap: 8 }}>
        <button type="button" className="small" onClick={() => eingabe.current?.click()} disabled={aktiv}>
          {aktiv && <span className="led" style={{ background: 'currentColor' }} />}
          Dateien hochladen
        </button>
        <span className="muted small">oder hierher ziehen — landet in Google Drive (Ablage „Einkauf")</span>
      </div>
      <input
        ref={eingabe}
        type="file"
        multiple
        hidden
        aria-label="Dateien auswählen"
        onChange={(e) => {
          void alle([...(e.currentTarget.files ?? [])])
          e.currentTarget.value = ''
        }}
      />
      {laeufe.length > 0 && (
        <ul className="dok-laeufe">
          {laeufe.map((l, i) => (
            <li key={`${l.name}-${i}`}>
              <span className="small">{l.name}</span>
              {l.fehler ? (
                <span className="small" style={{ color: 'var(--danger)' }}>
                  {l.fehler}
                </span>
              ) : (
                <span className="dok-balken" aria-label={`${l.prozent} %`}>
                  <span style={{ width: `${l.prozent}%` }} className={l.fertig ? 'fertig' : ''} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Art und Revision je Datei ändern, Verknüpfung lösen. */
export function DokumentZeilenKnoepfe({
  dokumentId,
  art,
  revision,
  modell,
  recordId,
}: {
  dokumentId: string
  art: DokumentArt
  revision: string | null
  modell: DokumentModell
  recordId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fehler, setFehler] = useState<string | null>(null)

  function speichern(teil: { art?: string; revision?: string }) {
    setFehler(null)
    const fd = new FormData()
    fd.set('dokument_id', dokumentId)
    if (teil.art) fd.set('art', teil.art)
    if (teil.revision !== undefined) fd.set('revision', teil.revision)
    startTransition(async () => {
      const r = await dokumentAendern(modell, recordId, fd)
      if (isActionError(r)) setFehler(r.error)
      else router.refresh()
    })
  }

  return (
    <div className="dok-knoepfe">
      <select
        aria-label="Art"
        defaultValue={art}
        disabled={pending}
        onChange={(e) => speichern({ art: e.currentTarget.value })}
      >
        {Object.entries(DOKUMENT_ARTEN).map(([wert, label]) => (
          <option key={wert} value={wert}>
            {label}
          </option>
        ))}
      </select>
      <input
        aria-label="Revision"
        placeholder="Rev."
        defaultValue={revision ?? ''}
        disabled={pending}
        style={{ width: 64 }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim() !== (revision ?? '')) speichern({ revision: e.currentTarget.value.trim() })
        }}
      />
      <button
        type="button"
        className="small"
        disabled={pending}
        title="Verknüpfung lösen — die Datei bleibt in Drive"
        onClick={() => {
          if (!window.confirm('Datei von diesem Beleg lösen? Sie bleibt in der Ablage.')) return
          startTransition(async () => {
            const r = await dokumentLoesen(dokumentId, modell, recordId)
            if (isActionError(r)) setFehler(r.error)
            else router.refresh()
          })
        }}
      >
        Lösen
      </button>
      {fehler && (
        <span className="small" style={{ color: 'var(--danger)' }}>
          {fehler}
        </span>
      )}
    </div>
  )
}
