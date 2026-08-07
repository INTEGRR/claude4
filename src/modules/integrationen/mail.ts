import 'server-only'

/**
 * E-Mail-Versand über Resend. Ohne API-Key wird die Mail nur protokolliert -
 * das hält Entwicklung und Tests ohne externen Dienst lauffähig.
 */

export interface MailAttachment {
  filename: string
  /** Base64-kodierter Inhalt. */
  content: string
}

export interface MailInput {
  to: string
  subject: string
  html: string
  attachments?: MailAttachment[]
}

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

export async function sendMail(mail: MailInput): Promise<void> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.MAIL_FROM ?? 'ERP <noreply@example.com>'
  const { logTransaction } = await import('./transaktionen')

  if (!key) {
    console.info(`[mail] Kein RESEND_API_KEY gesetzt — E-Mail an ${mail.to} nicht versendet: ${mail.subject}`)
    await logTransaction({
      system: 'mail', kind: 'send', reference: mail.to, ok: true,
      request: { subject: mail.subject },
      error: 'nicht versendet (RESEND_API_KEY fehlt)',
    })
    return
  }

  const start = Date.now()
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      attachments: mail.attachments,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    await logTransaction({
      system: 'mail', kind: 'send', reference: mail.to, ok: false,
      statusCode: res.status, request: { subject: mail.subject },
      error: text.slice(0, 500), durationMs: Date.now() - start,
    })
    throw new Error(`E-Mail-Versand fehlgeschlagen (${res.status}): ${text}`)
  }
  await logTransaction({
    system: 'mail', kind: 'send', reference: mail.to, ok: true,
    statusCode: res.status, request: { subject: mail.subject },
    durationMs: Date.now() - start,
  })
}
