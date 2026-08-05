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

  if (!key) {
    console.info(`[mail] Kein RESEND_API_KEY gesetzt — E-Mail an ${mail.to} nicht versendet: ${mail.subject}`)
    return
  }

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
    throw new Error(`E-Mail-Versand fehlgeschlagen (${res.status}): ${await res.text()}`)
  }
}
