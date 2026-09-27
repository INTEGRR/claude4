/**
 * Feste Größe für ein SVG, das nur eine viewBox mitbringt (bwip-js liefert
 * genau das). Ohne width/height hat ein Inline-SVG in einem Flex- oder
 * Inline-Container keine eigene Breite und schrumpft auf 0 px — so blieb der
 * QR-Code bei der 2FA-Einrichtung unsichtbar (Fehler vom 2026-09-27).
 *
 * Pur (keine Importe), damit unter blankem Node testbar.
 */
export function svgMitGroesse(svg: string, breite: number, hoehe: number = breite): string {
  return svg.replace(/<svg\b([^>]*)>/, (_, attribute: string) => {
    const ohne = attribute
      .replace(/\s(width|height|shape-rendering)="[^"]*"/g, '')
      .trimEnd()
    return `<svg${ohne} width="${breite}" height="${hoehe}" shape-rendering="crispEdges">`
  })
}
