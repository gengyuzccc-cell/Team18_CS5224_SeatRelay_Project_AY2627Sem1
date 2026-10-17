import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Toast region (`aria-live="polite"`). `push({ id })` updates an existing toast in place, which
 * is how the command flow turns "Sending…" → "Request received" → "Seat confirmed" into one
 * card instead of three (plan §1.3 distinguishes "received" from "confirmed").
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastInput {
  id?: string;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Stay until dismissed or updated. */
  sticky?: boolean;
}

export interface Toast extends ToastInput {
  id: string;
}

export interface ToastApi {
  push(toast: ToastInput): string;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);
const AUTO_DISMISS_MS = 7_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): string => {
      counter.current += 1;
      const id = input.id ?? `toast-${counter.current}`;
      const toast: Toast = { ...input, id };
      setToasts((current) => {
        const index = current.findIndex((existing) => existing.id === id);
        if (index < 0) {
          return [...current, toast];
        }
        const next = [...current];
        next[index] = toast;
        return next;
      });
      const existing = timers.current.get(id);
      if (existing !== undefined) {
        clearTimeout(existing);
        timers.current.delete(id);
      }
      if (!toast.sticky) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-relevant="additions text">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <div className="toast-body">
              <strong>{toast.title}</strong>
              {toast.message !== undefined && <p>{toast.message}</p>}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  if (api === undefined) {
    throw new Error('useToasts must be used inside <ToastProvider>');
  }
  return api;
}
