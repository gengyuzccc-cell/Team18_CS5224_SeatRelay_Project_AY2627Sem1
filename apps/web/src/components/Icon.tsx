import type { ReactNode } from 'react';

/**
 * Small inline SVG icon set (no icon font, no dependency). Every icon is decorative
 * (`aria-hidden`): the text next to it carries the meaning, so no `<title>` is rendered.
 */
export type IconName =
  | 'check'
  | 'clock'
  | 'x'
  | 'alert'
  | 'refresh'
  | 'copy'
  | 'external'
  | 'arrow-right'
  | 'link'
  | 'seat'
  | 'tri-up'
  | 'tri-down';

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.25l2.75 1.75" />
    </>
  ),
  x: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  alert: (
    <>
      <path d="M10 3.25l7.25 12.5H2.75z" />
      <path d="M10 8.25v3.5M10 14.1v.15" />
    </>
  ),
  refresh: (
    <>
      <path d="M15.5 8.25A5.75 5.75 0 0 0 5 6.5L3.75 8" />
      <path d="M3.75 4.25V8h3.75" />
      <path d="M4.5 11.75A5.75 5.75 0 0 0 15 13.5l1.25-1.5" />
      <path d="M16.25 15.75V12H12.5" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6.5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h2" />
    </>
  ),
  external: (
    <>
      <path d="M11.5 3.5h5v5M16.5 3.5l-7 7" />
      <path d="M14.5 11.5v3.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5h3.5" />
    </>
  ),
  'arrow-right': <path d="M4 10h11.5M11 5.5l4.5 4.5-4.5 4.5" />,
  link: (
    <>
      <path d="M8.5 11.5a3.25 3.25 0 0 0 4.6 0l2.4-2.4a3.25 3.25 0 0 0-4.6-4.6l-.9.9" />
      <path d="M11.5 8.5a3.25 3.25 0 0 0-4.6 0l-2.4 2.4a3.25 3.25 0 0 0 4.6 4.6l.9-.9" />
    </>
  ),
  seat: (
    <>
      <path d="M5.5 10V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5" />
      <path d="M3.5 10.5a1.5 1.5 0 0 1 3 0V12h7v-1.5a1.5 1.5 0 0 1 3 0V14a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      <path d="M5.5 15v2M14.5 15v2" />
    </>
  ),
  'tri-up': <polygon points="10,5 16,14 4,14" fill="currentColor" stroke="none" />,
  'tri-down': <polygon points="4,6 16,6 10,15" fill="currentColor" stroke="none" />,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      focusable="false"
      width="1em"
      height="1em"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/** SeatRelay mark: an empty seat, a relay arc, and the seat held for the next person (orange). */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      aria-hidden="true"
      focusable="false"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
    >
      <rect x="2" y="11" width="7" height="8" rx="1.5" stroke="#003D7C" strokeWidth="1.75" />
      <path
        d="M6 8.5C8 4.5 14.5 4 17.25 8"
        stroke="#003D7C"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M14.75 7.75l2.6.6.45-2.6"
        stroke="#003D7C"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="11" width="7" height="8" rx="1.5" fill="#E07000" />
    </svg>
  );
}
