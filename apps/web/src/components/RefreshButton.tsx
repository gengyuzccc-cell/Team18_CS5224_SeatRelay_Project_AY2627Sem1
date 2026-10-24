import { useState } from 'react';
import { Icon } from './Icon';

/**
 * "Refresh" for a polled page. Only a refresh the user asked for shows "Refreshing…" and spins
 * the icon; background polls leave the button alone, so the header does not flicker or shift
 * every few seconds.
 */
export function RefreshButton({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [manual, setManual] = useState(false);
  const click = () => {
    setManual(true);
    void onRefresh().finally(() => setManual(false));
  };
  return (
    <button
      type="button"
      className="btn btn-secondary btn-small btn-refresh"
      onClick={click}
      disabled={manual}
    >
      <Icon name="refresh" className={manual ? 'spin' : undefined} />
      {manual ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}
