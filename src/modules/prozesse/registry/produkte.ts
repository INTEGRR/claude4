import { AKTIONEN } from '../../ki/aktionen.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Produktbereichs. Die Produktanlage teilt sich Schema und
 * Fachlogik mit der KI-Aktion `produkt_anlegen` — eine Definition, drei
 * Transporte (KI-Chat, generierte Maske, Prozesstest). Die Richtung stimmt
 * schon mit Phase 6 überein, wo der KI-Katalog ganz aus der Registry kommt.
 */
export const PRODUKTE = {
  'produkte.produkt_anlegen': {
    label: AKTIONEN.produkt_anlegen.label,
    bereich: 'produkte',
    beschreibung: AKTIONEN.produkt_anlegen.beschreibung,
    bindung: 'frei',
    schema: AKTIONEN.produkt_anlegen.schema,
    zusammenfassung: AKTIONEN.produkt_anlegen.zusammenfassung,
    revalidate: ['/produkte'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
