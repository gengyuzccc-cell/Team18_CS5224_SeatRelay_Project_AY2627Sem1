/**
 * In-page recorder of what a person actually sees change: toast texts ("Sending…" → "Request
 * received" → "Registration applied"), status lines (`role="status"`, e.g. "Request received,
 * waiting for the outcome…") and the status card's state class. Each change is reported through
 * the `__e2eRecord` binding with the browser's timestamp, so the walkthrough can assert the
 * order of the visible states even when one of them lasts only a few hundred milliseconds.
 *
 * Kept as a plain string: tsx/esbuild may wrap functions with helpers (`__name`) that do not
 * exist in the page when a function is serialised for `addInitScript`.
 */
export const OBSERVER_SCRIPT = `
(() => {
  if (window.__e2eObserverInstalled) return;
  window.__e2eObserverInstalled = true;
  const last = new WeakMap();
  let lastCard = '';
  const emit = (kind, text) => {
    try { window.__e2eRecord && window.__e2eRecord({ kind, text, at: Date.now(), path: location.pathname }); } catch (e) {}
  };
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const scan = () => {
    document.querySelectorAll('.toast').forEach((el) => {
      const title = el.querySelector('strong');
      const body = el.querySelector('p');
      const text = (title ? textOf(title) : '') + (body ? ' | ' + textOf(body) : '');
      if (last.get(el) !== text) { last.set(el, text); emit('toast', text); }
    });
    document.querySelectorAll('[role="status"]:not(.toast), [role="alert"]:not(.toast)').forEach((el) => {
      const text = textOf(el);
      if (text.length > 0 && last.get(el) !== text) { last.set(el, text); emit(el.getAttribute('role'), text); }
    });
    const card = document.querySelector('.status-card');
    const cardState = card ? (card.className.match(/status-(queued|offered|confirmed|ended|cancelled)/) || [, 'unknown'])[1] : 'none';
    if (cardState !== lastCard) { lastCard = cardState; emit('card', cardState); }
  };
  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'],
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;

/** Click highlight for the video: an amber ring around the element for a moment. */
export const HIGHLIGHT_STYLE = `
  [data-e2e-highlight] { outline: 3px solid #f59e0b !important; outline-offset: 2px !important;
    box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.25) !important; transition: none !important; }
`;

export interface ObservedEvent {
  actor: string;
  kind: string;
  text: string;
  at: number;
  path: string;
}
