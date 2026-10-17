import {
  CreateWorkshopBodySchema,
  DEFAULT_HOLD_SECONDS,
  MAX_HOLD_SECONDS,
  MAX_SESSIONS_PER_WORKSHOP,
  MIN_HOLD_SECONDS,
  MIN_SESSIONS_PER_WORKSHOP,
  WORKSHOP_MODES,
  type CreateWorkshopInput,
  type Workshop,
  type WorkshopMode,
} from '@seatrelay/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api/ApiProvider';
import { queryKeys, useOrgWorkshops } from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { describeError } from '../util/errors';
import { serverNow } from '../util/serverClock';
import { defaultLocalInput, formatDateTime, formatSeconds, localInputToIso } from '../util/time';

interface SessionDraft {
  key: number;
  title: string;
  startsAt: string;
  capacity: string;
}

function newDraft(index: number): SessionDraft {
  return {
    key: Date.now() + index,
    title: `Session ${index + 1}`,
    startsAt: defaultLocalInput(24 * (index + 1) + 2),
    capacity: '10',
  };
}

function toBody(
  basics: { title: string; description: string; mode: WorkshopMode; holdSeconds: string },
  sessions: SessionDraft[],
): CreateWorkshopInput {
  return {
    title: basics.title,
    description: basics.description,
    mode: basics.mode,
    holdSeconds: Number(basics.holdSeconds),
    sessions: sessions.map((session) => ({
      title: session.title,
      startsAt: localInputToIso(session.startsAt) ?? session.startsAt,
      capacity: Number(session.capacity),
    })),
  };
}

/** 3-step wizard: basics → 2–5 sessions → review; validated with the contracts schema. */
function CreateWorkshopWizard({ orgId }: { orgId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [basics, setBasics] = useState({
    title: '',
    description: '',
    mode: 'UNIFIED' as WorkshopMode,
    holdSeconds: String(DEFAULT_HOLD_SECONDS),
  });
  const [sessions, setSessions] = useState<SessionDraft[]>(() => [newDraft(0), newDraft(1)]);
  const [issues, setIssues] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [state, setState] = useState<AsyncState>('idle');
  const create = useMutation({
    mutationFn: (body: CreateWorkshopInput) => api.createWorkshop(orgId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.orgWorkshops(orgId) }),
  });

  const validate = (): CreateWorkshopInput | undefined => {
    const body = toBody(basics, sessions);
    const parsed = CreateWorkshopBodySchema.safeParse(body);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'form'}: ${issue.message}`),
      );
      return undefined;
    }
    // Advisory only: the server re-checks every cut-off with its own clock when the workshop is
    // created, and this browser's clock may be off (plan §1.4).
    const now = serverNow();
    const late = body.sessions.filter(
      (session) => Date.parse(session.startsAt) - 30 * 60_000 <= now,
    );
    setWarnings(
      late.map(
        (session) =>
          `${session.title}: starts within 30 minutes, so its registration cut-off has passed; the server will refuse it.`,
      ),
    );
    setIssues([]);
    return body;
  };

  const next = () => {
    if (step === 1) {
      if (basics.title.trim().length === 0) {
        setIssues(['title: required']);
        return;
      }
      const hold = Number(basics.holdSeconds);
      if (!Number.isInteger(hold) || hold < MIN_HOLD_SECONDS || hold > MAX_HOLD_SECONDS) {
        setIssues([`holdSeconds: integer between ${MIN_HOLD_SECONDS} and ${MAX_HOLD_SECONDS}`]);
        return;
      }
      setIssues([]);
      setStep(2);
    } else if (step === 2) {
      if (validate() !== undefined) {
        setStep(3);
      }
    }
  };

  const submit = async () => {
    const body = validate();
    if (body === undefined) {
      setStep(2);
      return;
    }
    setState('pending');
    try {
      const created = await create.mutateAsync(body);
      setState('done');
      navigate(
        `/org/${encodeURIComponent(orgId)}/workshops/${encodeURIComponent(created.workshop.id)}`,
      );
    } catch {
      setState('error');
    }
  };

  const updateSession = (key: number, patch: Partial<SessionDraft>) =>
    setSessions((current) =>
      current.map((session) => (session.key === key ? { ...session, ...patch } : session)),
    );

  return (
    <section className="card" aria-labelledby="wizard-heading">
      <header className="card-header">
        <h2 id="wizard-heading">Create a workshop</h2>
        <ol className="steps" aria-label="Steps">
          {[1, 2, 3].map((n) => (
            <li
              key={n}
              className={step === n ? 'step-active' : step > n ? 'step-done' : ''}
              aria-current={step === n ? 'step' : undefined}
            >
              {n === 1 ? 'Basics' : n === 2 ? 'Sessions' : 'Review'}
            </li>
          ))}
        </ol>
      </header>

      {step === 1 && (
        <div className="stack-tight">
          <div className="field">
            <label className="field-label" htmlFor="ws-title">
              Title
            </label>
            <input
              id="ws-title"
              type="text"
              maxLength={200}
              required
              value={basics.title}
              onChange={(event) => setBasics({ ...basics, title: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ws-desc">
              Description
            </label>
            <textarea
              id="ws-desc"
              rows={3}
              maxLength={5000}
              value={basics.description}
              onChange={(event) => setBasics({ ...basics, description: event.target.value })}
            />
          </div>
          <div className="field-row field-row-top">
            <div className="field">
              <label className="field-label" htmlFor="ws-mode">
                Mode
              </label>
              <select
                id="ws-mode"
                value={basics.mode}
                onChange={(event) =>
                  setBasics({ ...basics, mode: event.target.value as WorkshopMode })
                }
              >
                {WORKSHOP_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'UNIFIED'
                      ? 'UNIFIED — one queue, ranked preferences, one seat per person'
                      : 'PER_SESSION — baseline: separate queue per session'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ws-hold">
                Hold time (seconds)
              </label>
              <input
                id="ws-hold"
                type="number"
                min={MIN_HOLD_SECONDS}
                max={MAX_HOLD_SECONDS}
                step={1}
                value={basics.holdSeconds}
                onChange={(event) => setBasics({ ...basics, holdSeconds: event.target.value })}
              />
              <span className="muted small">
                default {DEFAULT_HOLD_SECONDS} ({formatSeconds(DEFAULT_HOLD_SECONDS)}), minimum{' '}
                {MIN_HOLD_SECONDS}
              </span>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="stack-tight">
          <p className="muted small">
            {MIN_SESSIONS_PER_WORKSHOP}–{MAX_SESSIONS_PER_WORKSHOP} sessions. Registration for a
            session closes 30 minutes before it starts.
          </p>
          {sessions.map((session, index) => (
            <fieldset key={session.key} className="fieldset session-row">
              <legend>Session {index + 1}</legend>
              <div className="field-row">
                <div className="field grow">
                  <label className="field-label" htmlFor={`s-title-${session.key}`}>
                    Title
                  </label>
                  <input
                    id={`s-title-${session.key}`}
                    type="text"
                    maxLength={200}
                    value={session.title}
                    onChange={(event) => updateSession(session.key, { title: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`s-start-${session.key}`}>
                    Starts (local time)
                  </label>
                  <input
                    id={`s-start-${session.key}`}
                    type="datetime-local"
                    value={session.startsAt}
                    onChange={(event) =>
                      updateSession(session.key, { startsAt: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`s-cap-${session.key}`}>
                    Capacity
                  </label>
                  <input
                    id={`s-cap-${session.key}`}
                    type="number"
                    min={1}
                    step={1}
                    value={session.capacity}
                    onChange={(event) =>
                      updateSession(session.key, { capacity: event.target.value })
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-label={`Remove session ${index + 1}`}
                  disabled={sessions.length <= MIN_SESSIONS_PER_WORKSHOP}
                  onClick={() =>
                    setSessions((current) => current.filter((s) => s.key !== session.key))
                  }
                >
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={sessions.length >= MAX_SESSIONS_PER_WORKSHOP}
            onClick={() => setSessions((current) => [...current, newDraft(current.length)])}
          >
            Add session
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="stack-tight">
          <dl className="review">
            <dt>Title</dt>
            <dd>{basics.title}</dd>
            <dt>Mode</dt>
            <dd>{basics.mode}</dd>
            <dt>Hold</dt>
            <dd>{formatSeconds(Number(basics.holdSeconds))}</dd>
            <dt>Sessions</dt>
            <dd>
              <ul className="list-plain">
                {sessions.map((session) => (
                  <li key={session.key}>
                    {session.title} · {formatDateTime(localInputToIso(session.startsAt))} · capacity{' '}
                    {session.capacity}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </div>
      )}

      {issues.length > 0 && (
        <ul className="error-list" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {issues.length === 0 && warnings.length > 0 && (
        <ul className="error-list" role="status">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        {step > 1 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setStep(step === 3 ? 2 : 1)}
            disabled={state === 'pending'}
          >
            Back
          </button>
        )}
        {step < 3 ? (
          <button type="button" className="btn btn-primary" onClick={next}>
            Next
          </button>
        ) : (
          <AsyncButton
            state={state}
            idle="Create workshop"
            pending="Creating…"
            done="Created"
            error="Retry"
            onClick={() => void submit()}
          />
        )}
        {state === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(create.error)}
          </span>
        )}
      </div>
    </section>
  );
}

function WorkshopRow({ orgId, workshop }: { orgId: string; workshop: Workshop }) {
  return (
    <li className="list-row">
      <div>
        <Link to={`/org/${encodeURIComponent(orgId)}/workshops/${encodeURIComponent(workshop.id)}`}>
          <strong>{workshop.title}</strong>
        </Link>
        <div className="muted small">
          {workshop.mode} · hold {formatSeconds(workshop.holdSeconds)} · created{' '}
          {formatDateTime(workshop.createdAt)}
        </div>
      </div>
      <StatusBadge status={workshop.status} />
      <Link
        to={`/workshops/${encodeURIComponent(workshop.id)}`}
        className="btn btn-secondary btn-small"
      >
        Public page
      </Link>
    </li>
  );
}

function WorkshopList({ orgId }: { orgId: string }) {
  const query = useOrgWorkshops(orgId);
  if (query.isPending) {
    return <Loading label="Loading workshops…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner
        error={query.error}
        title="Could not load workshops"
        onRetry={() => void query.refetch()}
      />
    );
  }
  const workshops = [...query.data.workshops].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <section className="stack" aria-labelledby="ws-list-heading">
      <h2 id="ws-list-heading">Workshops</h2>
      {workshops.length === 0 ? (
        <p className="muted">No workshop yet.</p>
      ) : (
        <ul className="list">
          {workshops.map((workshop) => (
            <WorkshopRow key={workshop.id} orgId={orgId} workshop={workshop} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function OrgWorkshopsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  if (orgId === undefined) {
    return <ErrorBanner error={new Error('Missing organisation id')} />;
  }
  return (
    <div className="stack">
      <p className="muted small">
        <Link to="/org">← Organisations</Link>
      </p>
      <h1>Organisation workshops</h1>
      <RequireAuth purpose="Sign in to manage this organisation's workshops.">
        <WorkshopList orgId={orgId} />
        <CreateWorkshopWizard orgId={orgId} />
      </RequireAuth>
    </div>
  );
}
