'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ANSAGE_SCHLUESSEL, ANSAGE_STAND, type AnsageSchluessel } from '@/modules/scanner-ansagen'

const SPEICHER = 'krnl.scan.stimme'

/**
 * Sprachansagen im Scanfeld: lädt die festen Sätze einmal vor (Stimme wie
 * „Sprechen", vom Server erzeugt und zwischengespeichert) und spielt sie
 * sofort ab. Eine neue Ansage unterbricht die laufende — beim schnellen
 * Scannen zählt das Jetzt. Ohne Stimme (204) oder abgeschaltet liefert
 * ansagen() false, dann piept der Aufrufer wie bisher. Der Schalter gilt je
 * Gerät (localStorage, abgesichert).
 */
export function useAnsage() {
  const [an, setAn] = useState(true)
  const [verfuegbar, setVerfuegbar] = useState<boolean | null>(null)
  const vorrat = useRef(new Map<AnsageSchluessel, HTMLAudioElement>())
  const laeuft = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    try {
      if (localStorage.getItem(SPEICHER) === 'aus') setAn(false)
    } catch {
      // ohne Speicher bleibt die Stimme an
    }
  }, [])

  useEffect(() => {
    if (!an || verfuegbar === false) return
    let abgebrochen = false
    const laden = async (schluessel: AnsageSchluessel): Promise<boolean> => {
      if (vorrat.current.has(schluessel)) return true
      try {
        const res = await fetch(`/api/scanner/ansage/${schluessel}?v=${ANSAGE_STAND}`)
        if (res.status !== 200) return false
        const audio = new Audio(URL.createObjectURL(await res.blob()))
        audio.preload = 'auto'
        vorrat.current.set(schluessel, audio)
        return true
      } catch {
        return false
      }
    }
    void (async () => {
      // Erst ein Satz: ohne konfigurierte Stimme (204) spart das den Rest.
      const erster = await laden(ANSAGE_SCHLUESSEL[0])
      if (abgebrochen) return
      setVerfuegbar(erster)
      if (erster) await Promise.all(ANSAGE_SCHLUESSEL.slice(1).map(laden))
    })()
    return () => {
      abgebrochen = true
    }
  }, [an, verfuegbar])

  const ansagen = useCallback(
    (schluessel: AnsageSchluessel): boolean => {
      if (!an) return false
      const audio = vorrat.current.get(schluessel)
      if (!audio) return false
      laeuft.current?.pause()
      audio.currentTime = 0
      void audio.play().catch(() => undefined)
      laeuft.current = audio
      return true
    },
    [an],
  )

  const umschalten = useCallback(() => {
    setAn((vorher) => {
      const neu = !vorher
      try {
        localStorage.setItem(SPEICHER, neu ? 'an' : 'aus')
      } catch {
        // Schalter gilt dann nur bis zum Neuladen
      }
      if (!neu) laeuft.current?.pause()
      return neu
    })
  }, [])

  return { an, verfuegbar, ansagen, umschalten }
}
