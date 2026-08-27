import 'server-only'
import { toBuffer, toSVG } from 'bwip-js/node'

/**
 * Erzeugt Barcodes als SVG - dadurch sind sie in Druckansichten gestochen
 * scharf und brauchen keine Bilddateien.
 */

export function code128(text: string, opts: { height?: number; scale?: number } = {}): string {
  return toSVG({
    bcid: 'code128',
    text,
    height: opts.height ?? 12,
    scale: opts.scale ?? 3,
    includetext: true,
    textxalign: 'center',
    textsize: 8,
  })
}

/** EAN-13, fällt bei ungültigen Codes auf Code 128 zurück. */
export function ean13(text: string, opts: { height?: number; scale?: number } = {}): string {
  try {
    return toSVG({
      bcid: 'ean13',
      text,
      height: opts.height ?? 14,
      scale: opts.scale ?? 3,
      includetext: true,
      textsize: 8,
    })
  } catch {
    return code128(text, opts)
  }
}

/**
 * Wählt anhand des Inhalts das passende Symbol. Optionen (height/scale)
 * für kleine Zeilen-Barcodes auf Belegen — Standard bleibt Etikettengröße.
 */
export function barcodeSvg(value: string, opts: { height?: number; scale?: number } = {}): string {
  return /^\d{13}$/.test(value) ? ean13(value, opts) : code128(value, opts)
}

/**
 * Derselbe Barcode als PNG-Data-URI — für PDF-Ausgaben (react-pdf kann
 * kein rohes SVG einbetten). Symbolwahl wie barcodeSvg.
 */
export async function barcodePngDataUri(
  value: string,
  opts: { height?: number; scale?: number } = {},
): Promise<string> {
  const basis = {
    text: value,
    height: opts.height ?? 12,
    scale: opts.scale ?? 3,
    includetext: true,
    textxalign: 'center' as const,
    textsize: 8,
  }
  let png: Buffer
  try {
    png = await toBuffer({ ...basis, bcid: /^\d{13}$/.test(value) ? 'ean13' : 'code128' })
  } catch {
    png = await toBuffer({ ...basis, bcid: 'code128' })
  }
  return `data:image/png;base64,${png.toString('base64')}`
}
