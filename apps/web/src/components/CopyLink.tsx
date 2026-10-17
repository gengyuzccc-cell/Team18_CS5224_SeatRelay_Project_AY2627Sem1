import { useState } from 'react';

/** Share link with a copy-to-clipboard button (falls back to a selectable input). */
export function CopyLink({ url, label = 'Share link' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied('idle'), 2000);
  };
  return (
    <div className="copy-link">
      <label className="field-label" htmlFor={`copy-${label}`}>
        {label}
      </label>
      <div className="copy-row">
        <input
          id={`copy-${label}`}
          type="text"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Select & copy' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
