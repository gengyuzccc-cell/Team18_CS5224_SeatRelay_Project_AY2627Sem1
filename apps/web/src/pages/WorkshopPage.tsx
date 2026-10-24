import type { SessionView, WorkshopPublicView } from '@seatrelay/contracts';
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  latestEndedRegistration,
  listBehindWorkshopView,
  needsCatchUp,
} from '../api/endedRegistration';
import {
  CONFIRMED_REFRESH_MS,
  LIVE_REFRESH_MS,
  useMyRegistrations,
  useWorkshop,
} from '../api/queries';
import { useSession } from '../auth/useSession';
import { rejectReasonText } from '../commands/copy';
import { useCommand, type CommandPhase } from '../commands/useCommand';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { CopyLink } from '../components/CopyLink';
import { EndedStatusCard } from '../components/EndedStatusCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { Icon } from '../components/Icon';
import { Loading } from '../components/Loading';
import { RefreshButton } from '../components/RefreshButton';
import { SeatLegend } from '../components/SeatLegend';
import { isCancelledLike, StatusBadge } from '../components/StatusBadge';
import { StatusCard } from '../components/StatusCard';
import {
  describePreferenceChange,
  preferenceRank,
  preferenceReducer,
  type PreferenceAction,
} from '../preferences/reducer';
import { describeError, isNotFound } from '../util/errors';
import { seatBarStyle } from '../util/seatBar';
import { serverNow } from '../util/serverClock';
import { formatDateTime, formatSeconds } from '../util/time';
import { useDocumentTitle } from '../util/useDocumentTitle';

function SessionsTable({ sessions }: { sessions: readonly SessionView[] }) {
  return (
    <div className="sheet">
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Sessions, capacity and queue</caption>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Starts</th>
              <th scope="col" className="hide-sm">
                Status
              </th>
              <th scope="col" className="num hide-sm">
                Capacity
              </th>
              <th scope="col" className="num hide-sm">
                Free
              </th>
              <th scope="col" className="num hide-sm">
                Waiting
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const cancelled = isCancelledLike(session.status);
              return (
                <tr key={session.id}>
                  <th scope="row">
                    {session.title}
                    {/* Phone layout only (the four columns it summarises are hidden there). */}
                    <span className="small session-compact">
                      <StatusBadge status={session.status} />
                      {cancelled
                        ? ` ${session.queueLength} waiting`
                        : ` ${session.free} free of ${session.capacity} · ${session.queueLength} waiting`}
                      {!cancelled && (
                        <span
                          className="seat-bar-inline"
                          style={seatBarStyle(session)}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  </th>
                  <td>
                    {formatDateTime(session.startsAt)}
                    <div className="muted small">cut-off {formatDateTime(session.cutoffAt)}</div>
                  </td>
                  <td className="hide-sm">
                    <StatusBadge status={session.status} />
                  </td>
                  <td
                    className={`num hide-sm${cancelled ? '' : ' seat-bar'}`}
                    style={cancelled ? undefined : seatBarStyle(session)}
                  >
                    {session.capacity}
                  </td>
                  <td className="num hide-sm">{cancelled ? '—' : session.free}</td>
                  <td className="num hide-sm">{session.queueLength}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SeatLegend />
    </div>
  );
}

/** Sessions that can still be joined: not cancelled and before their cut-off (server clock). */
export function joinableSessions(
  sessions: readonly SessionView[],
  now: number = serverNow(),
): SessionView[] {
  return sessions.filter(
    (session) => !isCancelledLike(session.status) && Date.parse(session.cutoffAt) > now,
  );
}

/** How long the page waits before asking again for a `/me/registrations` that is behind. */
export const LIST_CATCH_UP_DELAY_MS = 1_500;
export const LIST_CATCH_UP_ATTEMPTS = 4;

function stateOf(state: CommandPhase): AsyncState {
  switch (state.phase) {
    case 'submitting':
    case 'processing':
      return 'pending';
    case 'applied':
      return 'done';
    case 'error':
      return state.retryable ? 'error' : 'idle';
    default:
      return 'idle';
  }
}

/** Checkboxes of acceptable sessions + up/down to order preference (UNIFIED), radio (PER_SESSION). */
function RegistrationForm({
  view,
  onChanged,
  autoFocus = false,
}: {
  view: WorkshopPublicView;
  onChanged: () => void;
  /** Bring the form into view and focus its first choice ("Register again"). */
  autoFocus?: boolean;
}) {
  const { workshop, sessions } = view;
  const perSession = workshop.mode === 'PER_SESSION';
  // Cut-offs are judged on the server's clock (plan §1.4), not the browser's.
  const joinable = useMemo(() => joinableSessions(sessions), [sessions]);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (autoFocus) {
      formRef.current?.scrollIntoView({ block: 'nearest' });
      formRef.current?.querySelector('input')?.focus();
    }
  }, [autoFocus]);
  const [selected, dispatch] = useReducer(preferenceReducer, []);
  // Which row the last ▲/▼ moved (restarts its settle animation on every press), where focus
  // goes back after the move, and what a screen reader hears.
  // `moved` is cleared when the settle animation ends, so a row React re-inserts later does not
  // replay it; the press counter lives in a ref to survive that reset.
  const [moved, setMoved] = useState<{ id: string; dir: 'up' | 'down'; n: number }>();
  const moveCount = useRef(0);
  const pendingFocus = useRef<
    { kind: 'move'; id: string; dir: 'up' | 'down' } | { kind: 'toggle'; id: string }
  >();
  const listRef = useRef<HTMLOListElement>(null);
  const [announce, setAnnounce] = useState('');
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Session';
  /** A choice made by the participant (not a prune): apply it and describe the new order. */
  const choose = (action: PreferenceAction) => {
    dispatch(action);
    setAnnounce(describePreferenceChange(action, preferenceReducer(selected, action), titleOf));
  };
  const move = (id: string, dir: 'up' | 'down') => {
    pendingFocus.current = { kind: 'move', id, dir };
    choose(dir === 'up' ? { type: 'moveUp', id } : { type: 'moveDown', id });
    moveCount.current += 1;
    setMoved({ id, dir, n: moveCount.current });
  };
  const order = selected.join();
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) {
      return;
    }
    pendingFocus.current = undefined;
    if (target.kind === 'toggle') {
      // Ticking or unticking re-sorts the list; moving the focused row blurs its checkbox.
      document.getElementById(`pref-${target.id}`)?.focus();
      return;
    }
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-move]') ?? [],
    );
    const same = buttons.find((b) => b.dataset.move === `${target.id}:${target.dir}`);
    const opposite = buttons.find(
      (b) => b.dataset.move === `${target.id}:${target.dir === 'up' ? 'down' : 'up'}`,
    );
    if (same !== undefined && !same.disabled) {
      same.focus();
    } else if (opposite !== undefined && !opposite.disabled) {
      opposite.focus();
    }
  }, [order]);
  const command = useCommand(workshop.id, { sessions, onSettled: onChanged });
  const [validation, setValidation] = useState<string | undefined>(undefined);

  const joinableIds = useMemo(() => joinable.map((session) => session.id), [joinable]);
  useEffect(() => {
    dispatch({ type: 'prune', valid: joinableIds });
  }, [joinableIds]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      setValidation(
        perSession
          ? 'Choose the session you want to join.'
          : 'Tick at least one session you could attend.',
      );
      return;
    }
    setValidation(undefined);
    if (command.canRetry) {
      // The inputs are locked meanwhile: what is re-sent is exactly what is shown.
      void command.retry();
      return;
    }
    void command.run({ type: 'REGISTER', acceptable: [...selected] });
  };

  const { state } = command;
  const phase = state.phase;
  // A retryable failure keeps the previous request (same commandId) until it is retried or
  // discarded, so the choices stay locked instead of silently not being sent.
  const locked = command.busy || command.canRetry;

  return (
    <form ref={formRef} className="card" onSubmit={submit} aria-labelledby="register-heading">
      <header className="card-header">
        <h2 id="register-heading">Register</h2>
      </header>
      <p className="muted">
        {perSession
          ? 'Per-session mode: pick exactly one session. You may register separately for other sessions.'
          : 'Tick every session you could attend, then order them by preference (1 = most preferred). You get one seat in the best available session; you never hold two.'}
      </p>
      {joinable.length === 0 ? (
        <p className="muted">
          No session can be joined any more (all cancelled or past their cut-off).
        </p>
      ) : (
        <fieldset className="fieldset" disabled={locked}>
          <legend>{perSession ? 'Session' : 'Acceptable sessions, in preference order'}</legend>
          <ol className="pref-list" ref={listRef}>
            {(perSession
              ? joinable
              : [...joinable].sort((a, b) => {
                  const ra = preferenceRank(selected, a.id) ?? Number.MAX_SAFE_INTEGER;
                  const rb = preferenceRank(selected, b.id) ?? Number.MAX_SAFE_INTEGER;
                  return ra - rb;
                })
            ).map((session) => {
              const rank = preferenceRank(selected, session.id);
              const checked = rank !== undefined;
              const inputId = `pref-${session.id}`;
              return (
                <li
                  key={session.id}
                  className={`pref-row${checked ? ' pref-selected' : ''}`}
                  data-moved={
                    moved?.id === session.id ? (moved.n % 2 === 1 ? 'a' : 'b') : undefined
                  }
                  data-dir={moved?.id === session.id ? moved.dir : undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget && moved?.id === session.id) {
                      setMoved(undefined);
                    }
                  }}
                >
                  <input
                    id={inputId}
                    type={perSession ? 'radio' : 'checkbox'}
                    name="acceptable"
                    checked={checked}
                    onChange={() => {
                      if (!perSession) {
                        pendingFocus.current = { kind: 'toggle', id: session.id };
                      }
                      choose(
                        perSession
                          ? { type: 'selectOnly', id: session.id }
                          : { type: 'toggle', id: session.id },
                      );
                    }}
                  />
                  <label htmlFor={inputId}>
                    {checked && !perSession && (
                      <span className="rank" aria-label={`preference ${rank}`}>
                        {rank}
                      </span>
                    )}
                    <span className="pref-title">{session.title}</span>
                    <span className="muted small">
                      {formatDateTime(session.startsAt)} · {session.free} free of {session.capacity}{' '}
                      · {session.queueLength} waiting
                    </span>
                  </label>
                  {!perSession && checked && (
                    <span className="pref-controls">
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Move ${session.title} up`}
                        disabled={rank === 1}
                        data-move={`${session.id}:up`}
                        onClick={() => move(session.id, 'up')}
                      >
                        <Icon name="tri-up" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Move ${session.title} down`}
                        disabled={rank === selected.length}
                        data-move={`${session.id}:down`}
                        onClick={() => move(session.id, 'down')}
                      >
                        <Icon name="tri-down" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </fieldset>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
      {validation !== undefined && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <div className="actions">
        <AsyncButton
          type="submit"
          state={stateOf(state)}
          idle={
            perSession
              ? 'Join the queue'
              : `Register${selected.length > 0 ? ` (${selected.length} session${selected.length === 1 ? '' : 's'})` : ''}`
          }
          pending={phase === 'submitting' ? 'Sending…' : 'Processing…'}
          done="Registered"
          error={
            state.phase === 'error' && state.stage === 'poll'
              ? 'Check the outcome'
              : 'Retry previous request'
          }
          disabled={joinable.length === 0}
        />
        {command.canRetry && state.phase === 'error' && state.stage === 'submit' && (
          <button type="button" className="btn btn-secondary" onClick={() => command.reset()}>
            Discard and edit
          </button>
        )}
        {state.phase === 'processing' && (
          <span className="muted small" role="status">
            {state.slow
              ? 'Still processing — checking every 5 s.'
              : 'Request received, waiting for the outcome…'}
          </span>
        )}
        {state.phase === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(state.error)}
            {state.retryable && state.stage === 'submit'
              ? ' Retrying sends the same choices again; discard to change them.'
              : ''}
          </span>
        )}
        {state.phase === 'rejected' && (
          <span className="error-text small" role="alert">
            Registration rejected: {rejectReasonText(state.view.reason)}
          </span>
        )}
      </div>
      <p className="muted small hold-note">
        <Icon name="clock" />
        Offers are held for {formatSeconds(workshop.holdSeconds)} (shorter near a session's cut-off,
        30 min before start).
      </p>
    </form>
  );
}

export function WorkshopPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const session = useSession();
  const query = useWorkshop(wsId);
  // History of my registrations: says how one ended once `me` (live only) has disappeared.
  const registrations = useMyRegistrations({ poll: false });
  const [registerAgainFor, setRegisterAgainFor] = useState<string | undefined>(undefined);
  const refetch = () => void query.refetch();
  useDocumentTitle(query.data?.workshop.title);

  const loaded = query.data;
  const me = loaded?.me;
  const mode = loaded?.workshop.mode ?? 'UNIFIED';
  // The live registration this page saw last. Once `me` is gone, the list has to show that one
  // as CANCELLED/ENDED before an ending is explained: on AWS the index can briefly list neither
  // its live nor its archived copy, and an older ending must not stand in for it meanwhile.
  const [lastLiveSeq, setLastLiveSeq] = useState<number | undefined>(undefined);
  if (me !== undefined && me.seq !== lastLiveSeq) {
    setLastLiveSeq(me.seq);
  }
  const awaitedSeq = loaded !== undefined && me === undefined ? lastLiveSeq : undefined;
  const latestEnded =
    loaded === undefined
      ? undefined
      : latestEndedRegistration(registrations.data, loaded.workshop.id, me, mode);
  const behind =
    loaded !== undefined &&
    needsCatchUp(registrations.data, loaded.workshop.id, me, mode, awaitedSeq);
  // The list still has my registration as live, or not at all, although the workshop view no
  // longer has it (a tick, an expiry or an organiser action ended it): no card can be shown yet,
  // and the empty form would be wrong, so the page waits for the list while catch-up attempts
  // remain.
  const listBehind =
    loaded !== undefined &&
    listBehindWorkshopView(registrations.data, loaded.workshop.id, me, mode, awaitedSeq);
  const [catchUpExhausted, setCatchUpExhausted] = useState(false);
  const ended =
    listBehind && !catchUpExhausted && latestEnded?.registration.seq !== awaitedSeq
      ? undefined
      : latestEnded;
  const refetchRegistrations = registrations.refetch;
  const refetchWorkshop = query.refetch;

  // My live registration changed (ended, re-queued, confirmed…): fetch the list again, it says
  // how a registration ended.
  const meKey = loaded === undefined ? undefined : `${me?.seq ?? '-'}:${me?.status ?? '-'}`;
  const previousMeKey = useRef(meKey);
  useEffect(() => {
    const previous = previousMeKey.current;
    previousMeKey.current = meKey;
    if (previous !== undefined && meKey !== undefined && previous !== meKey) {
      void refetchRegistrations();
    }
  }, [meKey, refetchRegistrations]);

  // The list still shows a registration as live that the (consistent) workshop view no longer
  // has, does not list it yet, or has only the poll result of how it ended: it is behind
  // (eventually consistent index). Ask again a few times. A failed refetch counts as an attempt
  // too: it moves `errorUpdatedAt`, not `dataUpdatedAt`, and must schedule the next attempt (or
  // end the loop) rather than leave the placeholder up.
  const catchUpAttempts = useRef(0);
  useEffect(() => {
    if (!behind) {
      catchUpAttempts.current = 0;
      setCatchUpExhausted(false);
      return;
    }
    if (catchUpAttempts.current >= LIST_CATCH_UP_ATTEMPTS) {
      // Still behind after the last attempt: stop waiting (the form or the card from what the
      // list says), rather than a placeholder that never goes away.
      setCatchUpExhausted(true);
      return;
    }
    const timer = setTimeout(() => {
      catchUpAttempts.current += 1;
      void refetchRegistrations();
      void refetchWorkshop();
    }, LIST_CATCH_UP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    behind,
    registrations.dataUpdatedAt,
    registrations.errorUpdatedAt,
    refetchRegistrations,
    refetchWorkshop,
  ]);

  if (wsId === undefined) {
    return <ErrorBanner error={new Error('Missing workshop id')} />;
  }
  if (query.isPending) {
    return <Loading label="Loading workshop…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner
        error={query.error}
        title={isNotFound(query.error) ? 'Workshop not found' : 'Could not load the workshop'}
        onRetry={refetch}
      />
    );
  }
  const view = query.data;
  const { workshop, sessions } = view;
  const closed = isCancelledLike(workshop.status);
  const shareUrl = `${window.location.origin}/workshops/${encodeURIComponent(workshop.id)}`;
  const endedKey =
    ended === undefined ? undefined : `${ended.registration.seq}:${ended.registration.status}`;
  const registeringAgain = endedKey !== undefined && registerAgainFor === endedKey;
  const canRegisterAgain = workshop.status === 'OPEN' && joinableSessions(sessions).length > 0;
  // UNIFIED: the form appears when there is nothing to explain, or after "Register again".
  // PER_SESSION: one registration per session, so the form is always there.
  const showForm =
    workshop.mode === 'PER_SESSION' ||
    (view.me === undefined && (ended === undefined || registeringAgain));
  const checkingHistory =
    workshop.mode === 'UNIFIED' &&
    view.me === undefined &&
    (registrations.isPending || (listBehind && !catchUpExhausted));
  const refreshNote =
    view.me === undefined
      ? undefined
      : view.me.status === 'QUEUED' || view.me.status === 'OFFERED'
        ? `This page refreshes every ${LIVE_REFRESH_MS / 1000} s while you are queued or offered (paused when the tab is hidden).`
        : view.me.status === 'CONFIRMED'
          ? `This page refreshes every ${CONFIRMED_REFRESH_MS / 1000} s while your seat is confirmed (paused when the tab is hidden).`
          : undefined;

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <p className="kicker">Workshop</p>
          <h1>{workshop.title}</h1>
          <p className="muted">
            <StatusBadge status={workshop.status} /> ·{' '}
            {workshop.mode === 'UNIFIED' ? 'Unified queue' : 'Per-session queues'} · hold{' '}
            {formatSeconds(workshop.holdSeconds)} · {view.queueLength} waiting in total
          </p>
        </div>
        <RefreshButton onRefresh={() => query.refetch()} />
      </header>
      {workshop.description.length > 0 && <p className="description">{workshop.description}</p>}

      <SessionsTable sessions={sessions} />

      {session.isLoading ? (
        <Loading label="Checking your session…" />
      ) : !session.isAuthenticated ? (
        <section className="card panel-center">
          <Icon name="seat" className="panel-icon" />
          <h2>Want a seat?</h2>
          <p className="muted">Sign in to register; you will come straight back to this page.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void session.signIn(`/workshops/${encodeURIComponent(workshop.id)}`)}
          >
            Sign in to register
          </button>
        </section>
      ) : (
        <>
          {view.me !== undefined && (
            <StatusCard
              workshop={workshop}
              sessions={sessions}
              registration={view.me}
              onChanged={refetch}
            />
          )}
          {ended !== undefined && (
            <EndedStatusCard
              sessions={sessions}
              mode={workshop.mode}
              registration={ended.registration}
              title={view.me === undefined ? 'My status' : 'Your last ended registration'}
              {...(canRegisterAgain && !registeringAgain
                ? { onRegisterAgain: () => setRegisterAgainFor(endedKey) }
                : {})}
            />
          )}
          {closed ? (
            <p className="banner banner-info">
              This workshop is {workshop.status === 'CANCELLING' ? 'being cancelled' : 'cancelled'};
              no further actions are possible.
            </p>
          ) : workshop.status === 'CLOSED' ? (
            <p className="banner banner-info">Registration is closed by the organiser.</p>
          ) : checkingHistory ? (
            <Loading label="Checking your registrations…" />
          ) : showForm ? (
            <RegistrationForm
              key={view.me?.seq ?? 'new'}
              view={view}
              onChanged={refetch}
              autoFocus={registeringAgain}
            />
          ) : null}
          {refreshNote !== undefined && <p className="muted small">{refreshNote}</p>}
        </>
      )}

      <CopyLink url={shareUrl} />
    </div>
  );
}
