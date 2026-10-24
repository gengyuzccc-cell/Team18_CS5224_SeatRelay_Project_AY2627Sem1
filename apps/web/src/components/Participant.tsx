/**
 * A participant in the organiser tables: the display name on one line and `<e-mail>` (kept on
 * one line) under it, or the e-mail alone. The text is exactly `participantLabel`'s; only the
 * layout differs, so a narrow column never breaks the address in the middle.
 */
export function Participant({ displayName, email }: { displayName?: string; email: string }) {
  if (displayName === undefined) {
    return <span className="who-email">{email}</span>;
  }
  return (
    <>
      <span className="who">{displayName}</span>{' '}
      <span className="who-email small muted">&lt;{email}&gt;</span>
    </>
  );
}
