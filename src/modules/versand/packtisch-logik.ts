/**
 * Der Positionsabgleich des Packtischs, pur und app-frei: gescannt wird
 * gegen SKU ODER Artikel-Barcode (case-insensitiv), und erst wenn jede
 * Sollzeile vollständig gescannt ist und kein fremder Artikel dabei war,
 * darf abgeschlossen werden. Genutzt vom Packtisch-Arbeitsplatz (Anzeige)
 * und von versand.packtisch_abschliessen (harte Serverprüfung).
 */

export interface PacktischSollzeile {
  qty: number
  sku: string | null
  barcode: string | null
  product: string
}

export interface PacktischAbgleich {
  /** Zeilen mit zu wenig Scans, als Klartext „SKU (ist/soll)". */
  fehlend: string[]
  /** Gescannte Schlüssel, die zu keiner Sollzeile gehören. */
  fremd: string[]
  vollstaendig: boolean
}

export function packtischAbgleich(
  soll: PacktischSollzeile[],
  gepackt: Record<string, number>,
): PacktischAbgleich {
  const gescannt = new Map(
    Object.entries(gepackt).map(([k, v]) => [k.trim().toLowerCase(), Number(v)]),
  )
  const fehlend: string[] = []
  for (const zeile of soll) {
    const menge =
      (zeile.sku ? gescannt.get(zeile.sku.toLowerCase()) : undefined) ??
      (zeile.barcode ? gescannt.get(zeile.barcode.toLowerCase()) : undefined) ??
      0
    if (menge < Number(zeile.qty)) {
      fehlend.push(`${zeile.sku ?? zeile.product} (${menge}/${Number(zeile.qty)})`)
    }
  }
  const bekannt = new Set(
    soll.flatMap((z) =>
      [z.sku?.toLowerCase(), z.barcode?.toLowerCase()].filter((x): x is string => Boolean(x)),
    ),
  )
  const fremd = [...gescannt.keys()].filter((k) => !bekannt.has(k))
  return { fehlend, fremd, vollstaendig: fehlend.length === 0 && fremd.length === 0 }
}
