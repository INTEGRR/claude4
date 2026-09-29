import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Minimaler ZIP-Schreiber (PKZIP, Deflate) für kleine Downloads wie das
 * Druckbrücken-Paket — ohne Abhängigkeit, nur Node-Bordmittel. Kein ZIP64,
 * keine Verschlüsselung; Dateinamen in UTF-8 (Bit 11), Zeitstempel fest auf
 * die Erstellungszeit. Pur, unter blankem Node testbar.
 */

export interface ZipDatei {
  name: string
  inhalt: Buffer | string
}

/** DOS-Datum und -Uhrzeit, wie ZIP sie im Kopf erwartet. */
function dosZeit(d: Date): { zeit: number; datum: number } {
  return {
    zeit: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    datum: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function zipErstellen(dateien: ZipDatei[], erstellt: Date = new Date()): Buffer {
  const { zeit, datum } = dosZeit(erstellt)
  const lokal: Buffer[] = []
  const zentral: Buffer[] = []
  let versatz = 0

  for (const datei of dateien) {
    const name = Buffer.from(datei.name, 'utf8')
    const roh = Buffer.isBuffer(datei.inhalt) ? datei.inhalt : Buffer.from(datei.inhalt, 'utf8')
    const gepackt = deflateRawSync(roh)
    const pruefsumme = crc32(roh)

    const kopf = Buffer.alloc(30)
    kopf.writeUInt32LE(0x04034b50, 0) // Local file header
    kopf.writeUInt16LE(20, 4) // benötigte Version 2.0
    kopf.writeUInt16LE(0x0800, 6) // Bit 11: Name in UTF-8
    kopf.writeUInt16LE(8, 8) // Deflate
    kopf.writeUInt16LE(zeit, 10)
    kopf.writeUInt16LE(datum, 12)
    kopf.writeUInt32LE(pruefsumme, 14)
    kopf.writeUInt32LE(gepackt.length, 18)
    kopf.writeUInt32LE(roh.length, 22)
    kopf.writeUInt16LE(name.length, 26)
    kopf.writeUInt16LE(0, 28)
    lokal.push(kopf, name, gepackt)

    const eintrag = Buffer.alloc(46)
    eintrag.writeUInt32LE(0x02014b50, 0) // Central directory header
    eintrag.writeUInt16LE(20, 4) // erstellt mit 2.0
    eintrag.writeUInt16LE(20, 6)
    eintrag.writeUInt16LE(0x0800, 8)
    eintrag.writeUInt16LE(8, 10)
    eintrag.writeUInt16LE(zeit, 12)
    eintrag.writeUInt16LE(datum, 14)
    eintrag.writeUInt32LE(pruefsumme, 16)
    eintrag.writeUInt32LE(gepackt.length, 20)
    eintrag.writeUInt32LE(roh.length, 24)
    eintrag.writeUInt16LE(name.length, 28)
    // Extra, Kommentar, Disk, interne Attribute: 0
    eintrag.writeUInt32LE(0, 38) // externe Attribute
    eintrag.writeUInt32LE(versatz, 42)
    zentral.push(eintrag, name)

    versatz += kopf.length + name.length + gepackt.length
  }

  const verzeichnis = Buffer.concat(zentral)
  const ende = Buffer.alloc(22)
  ende.writeUInt32LE(0x06054b50, 0) // End of central directory
  ende.writeUInt16LE(dateien.length, 8)
  ende.writeUInt16LE(dateien.length, 10)
  ende.writeUInt32LE(verzeichnis.length, 12)
  ende.writeUInt32LE(versatz, 16)
  return Buffer.concat([...lokal, verzeichnis, ende])
}
