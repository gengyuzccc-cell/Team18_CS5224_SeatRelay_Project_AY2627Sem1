/** How the organiser screens name a participant: `Display Name <e-mail>`, or the e-mail alone. */
export function participantLabel(entry: { displayName?: string; email: string }): string {
  return entry.displayName !== undefined ? `${entry.displayName} <${entry.email}>` : entry.email;
}
