import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Two-step inline confirm ("Release your seat?  Yes, cancel / Keep it"): when it opens, focus
 * moves to the safe button; "Keep it" or Escape closes it and returns focus to the button that
 * opened it. Confirming (`settle`) closes it and moves focus to the `fallback` element (a stable
 * element with tabIndex -1), because the button that opened it comes back disabled while the command
 * runs and focus would otherwise fall to <body>.
 *
 * Render the question in an element with id `questionId` and give the container
 * `role="group" aria-labelledby={questionId}` (see `groupProps`), so a screen reader announces
 * the question when focus enters the safe button.
 */
export function useInlineConfirm() {
  const [open, setOpen] = useState(false);
  const safeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLElement | null>(null);
  const restore = useRef<'trigger' | 'fallback' | undefined>(undefined);
  const questionId = useId();

  useEffect(() => {
    if (open) {
      safeRef.current?.focus();
      return;
    }
    const target = restore.current;
    restore.current = undefined;
    if (target === 'trigger') {
      triggerRef.current?.focus();
    } else if (target === 'fallback') {
      const trigger = triggerRef.current;
      if (trigger !== null && !trigger.disabled) {
        trigger.focus();
      } else {
        fallbackRef.current?.focus();
      }
    }
  }, [open]);

  const show = useCallback(() => setOpen(true), []);
  const dismiss = useCallback(() => {
    restore.current = 'trigger';
    setOpen(false);
  }, []);
  const settle = useCallback(() => {
    // Only move focus when it is inside the confirm (keyboard or click on "Yes").
    restore.current =
      safeRef.current?.parentElement?.contains(document.activeElement) === true
        ? 'fallback'
        : undefined;
    setOpen(false);
  }, []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    },
    [dismiss],
  );
  /** Callback ref for the element that takes focus after confirming (give it tabIndex -1). */
  const fallback = useCallback((element: HTMLElement | null) => {
    fallbackRef.current = element;
  }, []);
  const groupProps = {
    role: 'group',
    'aria-labelledby': questionId,
    onKeyDown,
  } as const;

  return {
    open,
    show,
    dismiss,
    settle,
    safeRef,
    triggerRef,
    fallback,
    onKeyDown,
    questionId,
    groupProps,
  };
}
