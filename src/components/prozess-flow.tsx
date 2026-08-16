'use client'
import { useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { FlowDiagramm, PositionierterKnoten } from '@/modules/prozesse/flow-layout'

/**
 * Prozessdiagramm-Viewer auf React Flow: Pan/Zoom/FitView, eigene Knoten je
 * Schrittart im Design-System (BPMN-inspiriert), Kantenbeschriftungen und
 * Laufzeit-Markierung (Standort mit LED, erledigter Pfad gedimmt mit Haken,
 * abgeschaltete Schritte gestrichelt). Die Koordinaten kommen fertig vom
 * ELK-Layout aus der Server Component — hier wird nur gerendert.
 *
 * Dieselbe Leinwand wird später der Drag-&-Drop-Editor.
 */

// React Flow verlangt für node.data eine Index-Signatur.
type SchrittDaten = PositionierterKnoten['daten'] & { breite: number; hoehe: number } & Record<string, unknown>
type SchrittNode = Node<SchrittDaten, 'schritt'>

const ART_TEXT: Record<string, string> = {
  aktion: 'Aktion',
  dienst: '⚙ Dienst · asynchron',
  ereignis: '⚡ Ereignis · wartet',
  matching: '≡ Klärung',
  prozess: '▣ Teilprozess',
}

function SchrittKnoten({ data }: NodeProps<SchrittNode>) {
  const d = data
  const klassen = [
    'flow-schritt',
    `flow-art-${d.art}`,
    d.aktuell ? 'ist-aktuell' : '',
    d.erledigt ? 'ist-erledigt' : '',
    d.abgeschaltet ? 'ist-abgeschaltet' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={klassen} style={{ width: d.breite, height: d.hoehe }}>
      <Handle type="target" position={Position.Top} className="flow-griff" />

      {d.art === 'start' || d.art === 'ende' ? (
        <div className="flow-rund">
          {d.art === 'start' ? '▷' : '◼'} {d.name}
        </div>
      ) : d.art === 'xor' ? (
        <div className="flow-xor" title={d.name}>
          <span>?</span>
          <div className="flow-xor-label">{d.name}</div>
        </div>
      ) : (
        <div className="flow-karte">
          <div className="flow-kopf">
            <span className="flow-name">
              {d.erledigt && <span className="flow-haken">✓ </span>}
              {d.aktuell && <span className="led on" />}
              {d.name}
            </span>
            {d.zustand && <span className="flow-zustand mono">{d.zustand}</span>}
          </div>
          <div className="flow-meta">
            <span className="mono-label">{ART_TEXT[d.art] ?? d.art}</span>
            {d.optional && <span className="mono-label">optional</span>}
            {d.rollen && d.rollen.length > 0 && (
              <span className="mono-label" title={`Rollen: ${d.rollen.join(', ')}`}>
                🔒 {d.rollen.join(', ')}
              </span>
            )}
          </div>
          {d.verknuepfung && (
            <div className="flow-verknuepfung mono" title={d.verknuepfung}>
              {d.art === 'prozess' && d.teilprozessStand
                ? `${d.verknuepfung} — ${d.teilprozessStand.fertig}/${d.teilprozessStand.gesamt} fertig`
                : d.verknuepfung}
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="flow-griff" />
    </div>
  )
}

const nodeTypes = { schritt: SchrittKnoten }

export function ProzessFlow({ d }: { d: FlowDiagramm }) {
  const nodes: SchrittNode[] = useMemo(
    () =>
      d.knoten.map((k) => ({
        id: k.id,
        type: 'schritt' as const,
        position: { x: k.x, y: k.y },
        data: { ...k.daten, breite: k.breite, hoehe: k.hoehe },
        draggable: false,
        connectable: false,
        selectable: false,
      })),
    [d],
  )

  const edges: Edge[] = useMemo(
    () =>
      d.verbindungen.map((v) => ({
        id: v.id,
        source: v.von,
        target: v.nach,
        type: 'smoothstep',
        label: v.beschriftung ?? undefined,
        labelStyle: { fill: 'var(--text-muted)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: v.aktiv ? 'var(--accent)' : 'var(--border-strong)',
        },
        className: [
          'flow-kante',
          v.erledigt ? 'ist-erledigt' : '',
          v.aktiv ? 'ist-aktiv' : '',
        ]
          .filter(Boolean)
          .join(' '),
      })),
    [d],
  )

  // Höhe an den Inhalt anlehnen — große Ketten scrollen nicht die Seite,
  // sondern zoomen/pannen in der Leinwand.
  const hoehe = Math.max(280, Math.min(560, d.hoehe + 40))

  return (
    <div className="flow-rahmen" style={{ height: hoehe }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="flow-hintergrund" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}
