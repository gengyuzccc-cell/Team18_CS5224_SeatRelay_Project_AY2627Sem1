import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type AsyncState = 'idle' | 'pending' | 'done' | 'error';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  state: AsyncState;
  idle: ReactNode;
  pending?: ReactNode;
  done?: ReactNode;
  error?: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}

/** Button with three-state copy (idle / pending / done + error) and `aria-busy`. */
export const AsyncButton = forwardRef<HTMLButtonElement, Props>(function AsyncButton(
  {
    state,
    idle,
    pending = 'Working…',
    done = 'Done',
    error = 'Retry',
    variant = 'primary',
    className = '',
    disabled,
    ...rest
  },
  ref,
) {
  const label =
    state === 'pending' ? pending : state === 'done' ? done : state === 'error' ? error : idle;
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn-${variant} ${className}`.trim()}
      aria-busy={state === 'pending'}
      disabled={disabled || state === 'pending'}
      data-state={state}
      {...rest}
    >
      {state === 'pending' && <span className="spinner" aria-hidden="true" />} {label}
    </button>
  );
});
