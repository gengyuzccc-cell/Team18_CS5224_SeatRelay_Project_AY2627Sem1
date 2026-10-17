import type { Organization } from '@seatrelay/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAddMember, useCreateOrg, useMe } from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { describeError } from '../util/errors';
import { formatDateTime } from '../util/time';

function CreateOrgForm() {
  const create = useCreateOrg();
  const [name, setName] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) {
      return;
    }
    setState('pending');
    try {
      await create.mutateAsync(name.trim());
      setName('');
      setState('done');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  };
  return (
    <form
      className="card"
      onSubmit={(event) => void submit(event)}
      aria-labelledby="create-org-heading"
    >
      <header className="card-header">
        <h2 id="create-org-heading">Create an organisation</h2>
      </header>
      <div className="field">
        <label className="field-label" htmlFor="org-name">
          Name
        </label>
        <input
          id="org-name"
          type="text"
          maxLength={120}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. NUS CS5224 Teaching Team"
        />
      </div>
      <div className="actions">
        <AsyncButton
          type="submit"
          state={state}
          idle="Create"
          pending="Creating…"
          done="Created"
          error="Retry"
        />
        {state === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(create.error)}
          </span>
        )}
      </div>
    </form>
  );
}

function AddMemberForm({ orgId }: { orgId: string }) {
  const add = useAddMember(orgId);
  const [value, setValue] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    setState('pending');
    try {
      await add.mutateAsync(trimmed.includes('@') ? { email: trimmed } : { userId: trimmed });
      setValue('');
      setState('done');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  };
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor={`member-${orgId}`}>
        Add organiser (email or user id)
      </label>
      <div className="copy-row">
        <input
          id={`member-${orgId}`}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="colleague@example.com"
        />
        <AsyncButton
          type="submit"
          variant="secondary"
          state={state}
          idle="Add"
          pending="Adding…"
          done="Added"
          error="Retry"
        />
      </div>
      {state === 'error' && (
        <span className="error-text small" role="alert">
          {describeError(add.error)}
        </span>
      )}
    </form>
  );
}

function OrgRow({ org }: { org: Organization }) {
  return (
    <li className="card">
      <header className="card-header">
        <h3>{org.name}</h3>
        <Link
          to={`/org/${encodeURIComponent(org.id)}/workshops`}
          className="btn btn-primary btn-small"
        >
          Workshops
        </Link>
      </header>
      <p className="muted small">
        {org.members.length} organiser{org.members.length === 1 ? '' : 's'} · created{' '}
        {formatDateTime(org.createdAt)} · id <code>{org.id}</code>
      </p>
      <AddMemberForm orgId={org.id} />
    </li>
  );
}

function OrgList() {
  const me = useMe();
  if (me.isPending) {
    return <Loading label="Loading your organisations…" />;
  }
  if (me.isError) {
    return (
      <ErrorBanner
        error={me.error}
        title="Could not load your organisations"
        onRetry={() => void me.refetch()}
      />
    );
  }
  const orgs = me.data.organizations;
  return (
    <section className="stack" aria-labelledby="orgs-heading">
      <h2 id="orgs-heading">My organisations</h2>
      {orgs.length === 0 ? (
        <p className="muted">You are not an organiser yet. Create an organisation below.</p>
      ) : (
        <ul className="stack list-plain">
          {orgs.map((org) => (
            <OrgRow key={org.id} org={org} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function OrgsPage() {
  return (
    <div className="stack">
      <h1>Organiser area</h1>
      <RequireAuth purpose="Sign in to manage organisations and workshops.">
        <OrgList />
        <CreateOrgForm />
      </RequireAuth>
    </div>
  );
}
