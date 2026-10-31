import { describeError } from '../util/errors';
import { Icon } from './Icon';

interface Props {
  error: unknown;
  title?: string;
  /** Replaces the error's own one-liner when the title already says what went wrong. */
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorBanner({
  error,
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Retry',
}: Props) {
  return (
    <div className="banner banner-error" role="alert">
      <div className="banner-lead">
        <Icon name="alert" />
        <div>
          <strong>{title}</strong>
          <p>{description ?? describeError(error)}</p>
        </div>
      </div>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
