import type { Notification } from '@seatrelay/contracts';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const FOOTER = 'You receive this e-mail because you registered with SeatRelay.';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain text plus a minimal HTML alternative for one stored notification. The engine writes the
 * whole text for people (core `notifications.ts`): the title already starts with what happened
 * ("Offer expired: Session 2") and the body renders times in the audience's zone, so the subject
 * is the title itself and nothing here re-formats timestamps.
 */
export function renderEmail(
  notification: Pick<Notification, 'kind' | 'title' | 'body'>,
): EmailContent {
  const subject = `[SeatRelay] ${notification.title}`;
  const text = `${notification.title}\n\n${notification.body}\n\n--\n${FOOTER}\n`;
  const paragraphs = notification.body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const html = [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;line-height:1.4">',
    `<h2>${escapeHtml(notification.title)}</h2>`,
    paragraphs,
    `<hr><p style="color:#666;font-size:12px">${escapeHtml(FOOTER)}</p>`,
    '</body></html>',
  ].join('\n');
  return { subject, text, html };
}
