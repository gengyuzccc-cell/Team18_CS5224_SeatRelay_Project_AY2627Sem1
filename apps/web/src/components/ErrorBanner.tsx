import { describeError } from '../util/errors';

interface Props {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorBanner({
  error,
  title = 'Something went wrong',
  onRetry,
  retryLabel = 'Retry',
}: Props) {
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{describeError(error)}</p>
      </div>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
