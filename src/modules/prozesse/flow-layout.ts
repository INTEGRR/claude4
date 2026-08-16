import 'server-only'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import {
  type FlowKante,
  type FlowKnoten,
  type FlowSchritt,
  type FlowVerbindung,
  flowDaten,
} from './flow-daten.ts'

/**
 * Positionierung des Prozessdiagramms mit ELK (Eclipse Layered — derselbe
 * Algorithmus, den BPMN-Werkzeuge nutzen): geschichtete Anordnung von oben
 * nach unten, saubere Zusammenführungen, kreuzungsarme Kanten. Läuft
 * SERVERSEITIG in der React Server Component — der Client bekommt fertige
 * Koordinaten und rendert nur (React Flow).
 */

export interface PositionierterKnoten extends FlowKnoten {
  x: number
  y: number
}

export interface FlowDiagramm {
  knoten: PositionierterKnoten[]
  verbindungen: FlowVerbindung[]
  breite: number
  hoehe: number
}

const elk = new ELK()

export async function flowLayout(
  schritte: FlowSchritt[],
  kanten: FlowKante[],
  aktuellerSchritt?: string | null,
): Promise<FlowDiagramm> {
  const { knoten, verbindungen } = flowDaten(schritte, kanten, aktuellerSchritt)

  const eingabe: ElkNode = {
    id: 'prozess',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '52',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeNode': '24',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'PREF_EDGES',
      'elk.padding': '[top=8,left=8,bottom=8,right=8]',
    },
    children: knoten.map((k) => ({ id: k.id, width: k.breite, height: k.hoehe })),
    edges: verbindungen.map((v) => ({ id: v.id, sources: [v.von], targets: [v.nach] })),
  }
  const graph = await elk.layout(eingabe)

  const position = new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
  const positioniert: PositionierterKnoten[] = knoten.map((k) => ({
    ...k,
    x: position.get(k.id)?.x ?? 0,
    y: position.get(k.id)?.y ?? 0,
  }))

  return {
    knoten: positioniert,
    verbindungen,
    breite: Math.ceil(graph.width ?? 800),
    hoehe: Math.ceil(graph.height ?? 400),
  }
}
