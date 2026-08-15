/**
 * Verweis auf das Quell-Repository — für die Commit-Verknüpfung an Tickets.
 * Überschreibbar per Umgebungsvariable, falls das Repo umzieht.
 */
const REPO_URL = process.env.ERP_REPO_URL ?? 'https://github.com/integrr/claude4'

export function commitUrl(sha: string): string {
  return `${REPO_URL}/commit/${sha}`
}

export function kurzerSha(sha: string): string {
  return sha.slice(0, 7)
}
