import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** An empty list or table: the sentence stays alone in its own paragraph, with a quiet icon. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name="seat" />
      <p className="muted">{children}</p>
    </div>
  );
}
