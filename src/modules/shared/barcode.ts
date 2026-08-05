import 'server-only'
import { toSVG } from 'bwip-js/node'

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
export function ean13(text: string): string {
  try {
    return toSVG({ bcid: 'ean13', text, height: 14, scale: 3, includetext: true, textsize: 8 })
  } catch {
    return code128(text)
  }
}

/** Wählt anhand des Inhalts das passende Symbol. */
export function barcodeSvg(value: string): string {
  return /^\d{13}$/.test(value) ? ean13(value) : code128(value)
}
