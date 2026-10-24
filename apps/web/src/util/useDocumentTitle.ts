import { useEffect } from 'react';

const APP = 'SeatRelay';

/** Sets `document.title` to "<title> · SeatRelay" (or "SeatRelay"), restored on unmount. */
export function useDocumentTitle(title?: string): void {
  useEffect(() => {
    document.title = title === undefined || title.length === 0 ? APP : `${title} · ${APP}`;
  }, [title]);
  useEffect(
    () => () => {
      document.title = APP;
    },
    [],
  );
}
