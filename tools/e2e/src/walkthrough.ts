/**
 * Real-browser walkthrough of a deployed SeatRelay stage (default: dev on CloudFront), following
 * docs/DEMO.md: four people in four isolated browser contexts sign in through the Cognito hosted
 * UI and drive the SPA exactly as a person would. Every visible state is asserted; any mismatch
 * stops the run with a screenshot of every window. On success it writes the screenshots
 * (docs/demo/screenshots/NN-name.png), a single cut of the recordings (docs/demo/backup-demo.mp4)
 * and an evidence summary (results/<date>-web-walkthrough-<stage>/).
 *
 *   pnpm --filter @seatrelay/e2e ensure-users          # once: the four walkthrough accounts
 *   pnpm --filter @seatrelay/e2e walkthrough           # full run, ~5 min
 *   pnpm --filter @seatrelay/e2e walkthrough -- --no-video --no-publish --headed
 *
 * Staged activity only: the accounts are test accounts whose display names say "(staged)", and
 * the organisation and workshop titles say so too. Nothing here is user evidence.
 */
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Locator, Page, Request } from 'playwright';
import { launchChromium } from './lib/browser';
import { cutLength, Director, ffmpegArgs, planClips, type VideoSource } from './lib/director';
import { signInWithHostedUi } from './lib/hostedUi';
import { HIGHLIGHT_STYLE, OBSERVER_SCRIPT, type ObservedEvent } from './lib/observer';

// ---------------------------------------------------------------------------------------------
// Options

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VIEWPORT = { width: 1440, height: 900 } as const;
const HOLD_SECONDS = 60;
const CAPACITIES = [2, 1, 1] as const;

/** Session starts as `datetime-local` values in Singapore time: 2, 3 and 4 days ahead, daytime. */
function sessionStarts(now = Date.now()): string[] {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const plan: readonly (readonly [number, string])[] = [
    [2, '10:00'],
    [3, '10:00'],
    [4, '14:00'],
  ];
  return plan.map(([days, time]) => `${day.format(new Date(now + days * 86_400_000))}T${time}`);
}
const SESSION_STARTS = sessionStarts();

interface Options {
  web: string;
  stage: string;
  prefix: string;
  password: string;
  headed: boolean;
  video: boolean;
  publish: boolean;
  results: boolean;
  /** Pause after each visible action, for the video (ms). */
  beat: number;
  typeDelay: number;
  outDir: string;
  screenshotsDir: string;
  videoPath: string;
  maxVideoMb: number;
}

/**
 * The walkthrough accounts' password (tools/e2e/bin/ensure-users.sh sets it): E2E_PASSWORD or
 * SEATRELAY_TEST_PASSWORD. The repository is public, so the local stack's default is refused.
 */
function walkthroughPassword(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.E2E_PASSWORD || env.SEATRELAY_TEST_PASSWORD;
  if (!password || password === 'Passw0rd!') {
    throw new Error('set SEATRELAY_TEST_PASSWORD (or E2E_PASSWORD) to the private password of the walkthrough accounts');
  }
  return password;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  // pnpm runs package scripts in tools/e2e; relative paths are meant from where pnpm was invoked.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const path = (flag: string, fallback: string) => {
    const given = value(flag);
    return given === undefined ? fallback : resolve(cwd, given);
  };
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const web = (
    value('--web') ??
    process.env.E2E_WEB_URL ??
    'https://d2ni5e1z674t04.cloudfront.net'
  ).replace(/\/$/, '');
  return {
    web,
    stage: value('--stage') ?? process.env.E2E_STAGE ?? 'dev',
    prefix: value('--prefix') ?? process.env.E2E_PREFIX ?? 'walkthrough',
    password: walkthroughPassword(),
    headed: has('--headed'),
    video: !has('--no-video'),
    publish: !has('--no-publish'),
    results: !has('--no-results'),
    beat: Number(value('--beat') ?? 900),
    typeDelay: Number(value('--type-delay') ?? 25),
    outDir: path('--out', join(REPO_ROOT, 'tools/e2e/out', stamp)),
    screenshotsDir: path('--screenshots', join(REPO_ROOT, 'docs/demo/screenshots')),
    videoPath: path('--video', join(REPO_ROOT, 'docs/demo/backup-demo.mp4')),
    maxVideoMb: Number(value('--max-video-mb') ?? 25),
  };
}

// ---------------------------------------------------------------------------------------------
// Run state

type ActorKey = 'organiser' | 'alice' | 'bob' | 'carol';

interface Actor {
  key: ActorKey;
  label: string;
  role: string;
  email: string;
  displayName: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  closedAt?: number;
}

interface NetEntry {
  actor: ActorKey;
  at: number;
  method: string;
  host: string;
  path: string;
  status?: number;
  ms?: number;
  failure?: string;
  /** POST /workshops/{id}/commands: the client-generated id and the command type. */
  commandId?: string;
  commandType?: string;
}

interface Shot {
  file: string;
  actor: ActorKey;
  caption: string;
}

interface Check {
  step: string;
  what: string;
  ok: boolean;
  detail?: string;
}

const opts = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const director = new Director();
const events: ObservedEvent[] = [];
const net: NetEntry[] = [];
const consoleErrors: { actor: ActorKey; at: number; text: string }[] = [];
const shots: Shot[] = [];
const checks: Check[] = [];
const observations: string[] = [];
const actors = new Map<ActorKey, Actor>();
const facts: Record<string, unknown> = {};
/** What each browser sent to the hosted UI's OAuth endpoints (no secrets: only the shape). */
interface OidcTrace {
  authorize?: {
    responseType: string | null;
    method: string | null;
    challenge: boolean;
    scope: string | null;
  };
  token?: { grantType: string | null; verifier: boolean };
}
const oidc = new Map<string, OidcTrace>();
const logLines: string[] = [];
let currentStep = 'setup';
let shotCounter = 0;
let apiOrigin = '';
let hostedUiOrigin = '';

mkdirSync(join(opts.outDir, 'screenshots'), { recursive: true });

function log(message: string): void {
  const line = `${new Date().toISOString()}  ${message}`;
  logLines.push(line);
  console.log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beat(factor = 1): Promise<void> {
  await sleep(Math.round(opts.beat * factor));
}

function check(what: string, ok: boolean, detail?: string): void {
  checks.push({ step: currentStep, what, ok, ...(detail !== undefined ? { detail } : {}) });
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) {
    throw new Error(`check failed: ${what}${detail !== undefined ? ` (${detail})` : ''}`);
  }
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  currentStep = name;
  log(`== ${name}`);
  await body();
}

function actor(key: ActorKey): Actor {
  const found = actors.get(key);
  if (found === undefined) {
    throw new Error(`actor ${key} not started`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Browser helpers

const PEOPLE: Record<ActorKey, { label: string; role: string; displayName: string }> = {
  organiser: { label: 'Organiser', role: 'organiser browser', displayName: 'Organiser (staged)' },
  alice: { label: 'Alice', role: 'participant browser', displayName: 'Alice (staged)' },
  bob: { label: 'Bob', role: 'participant browser', displayName: 'Bob (staged)' },
  carol: { label: 'Carol', role: 'participant browser', displayName: 'Carol (staged)' },
};

async function startActor(browser: Browser, key: ActorKey): Promise<Actor> {
  const person = PEOPLE[key];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'light',
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    acceptDownloads: true,
    ...(opts.video
      ? { recordVideo: { dir: join(opts.outDir, 'videos', key), size: VIEWPORT } }
      : {}),
  });
  await context.exposeBinding('__e2eRecord', (_source, entry: Omit<ObservedEvent, 'actor'>) => {
    events.push({ actor: key, ...entry });
  });
  await context.addInitScript({ content: OBSERVER_SCRIPT });
  await context.addInitScript({
    content: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(HIGHLIGHT_STYLE)}; document.head.appendChild(s); });`,
  });
  const started = new Map<object, number>();
  context.on('request', (request) => {
    started.set(request, Date.now());
    const url = new URL(request.url());
    if (url.origin !== hostedUiOrigin) {
      return;
    }
    if (url.pathname === '/oauth2/authorize') {
      oidc.set(key, {
        authorize: {
          responseType: url.searchParams.get('response_type'),
          method: url.searchParams.get('code_challenge_method'),
          challenge: (url.searchParams.get('code_challenge') ?? '').length > 0,
          scope: url.searchParams.get('scope'),
        },
      });
    } else if (url.pathname === '/oauth2/token' && request.method() === 'POST') {
      const body = new URLSearchParams(request.postData() ?? '');
      const trace = oidc.get(key) ?? {};
      if (trace.token === undefined) {
        trace.token = {
          grantType: body.get('grant_type'),
          verifier: (body.get('code_verifier') ?? '').length > 0,
        };
        oidc.set(key, trace);
      }
    }
  });
  const record = (request: Request, status?: number, failure?: string) => {
    const url = new URL(request.url());
    const origin = url.origin;
    if (
      origin !== apiOrigin &&
      origin !== hostedUiOrigin &&
      !url.hostname.startsWith('cognito-idp.')
    ) {
      return;
    }
    const at = started.get(request) ?? Date.now();
    let command: { commandId?: string; type?: string } | undefined;
    if (request.method() === 'POST' && url.pathname.endsWith('/commands')) {
      try {
        command = request.postDataJSON() as { commandId?: string; type?: string };
      } catch {
        command = undefined;
      }
    }
    net.push({
      actor: key,
      at,
      method: request.method(),
      host: url.hostname,
      path: url.pathname,
      ...(status !== undefined ? { status } : {}),
      ms: Date.now() - at,
      ...(failure !== undefined ? { failure } : {}),
      ...(command?.commandId !== undefined ? { commandId: command.commandId } : {}),
      ...(command?.type !== undefined ? { commandType: command.type } : {}),
    });
  };
  context.on('requestfinished', (request) => {
    void request.response().then((response) => record(request, response?.status()));
  });
  context.on('requestfailed', (request) =>
    record(request, undefined, request.failure()?.errorText),
  );
  const page = await context.newPage();
  const createdAt = Date.now();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push({ actor: key, at: Date.now(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push({ actor: key, at: Date.now(), text: `pageerror: ${error.message}` });
  });
  const created: Actor = {
    key,
    ...person,
    email: `${opts.prefix}-${key}@example.com`,
    context,
    page,
    createdAt,
  };
  actors.set(key, created);
  return created;
}

/** Clicks like a person (for the video: an amber ring around the target for a moment). */
async function click(target: Locator, hold = 350): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  // A handle, not the locator: the element may be gone after the click, and a locator would wait.
  const handle = await target.elementHandle();
  await handle?.evaluate((el) => el.setAttribute('data-e2e-highlight', ''));
  await sleep(hold);
  await target.click();
  await handle?.evaluate((el) => el.removeAttribute('data-e2e-highlight')).catch(() => undefined);
  await handle?.dispose();
}

async function shot(key: ActorKey, name: string, caption: string, fullPage = false): Promise<void> {
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(2, '0')}-${name}.png`;
  await actor(key).page.screenshot({ path: join(opts.outDir, 'screenshots', file), fullPage });
  shots.push({ file, actor: key, caption });
  log(`shot ${file} (${key})`);
}

/** Scrolls so that `target` sits near the top of the viewport (below the sticky top bar). */
async function scrollToTop(page: Page, target: Locator, offset = 80): Promise<void> {
  await target.evaluate((el, off) => {
    const top = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
  }, offset);
  await sleep(150);
}

async function scrollTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
}

function toast(page: Page, title: string): Locator {
  return page.locator('.toast').filter({ has: page.locator('strong', { hasText: title }) });
}

function statusCard(
  page: Page,
  state?: 'queued' | 'offered' | 'confirmed' | 'ended' | 'cancelled',
): Locator {
  return page.locator(state === undefined ? '.status-card' : `.status-card.status-${state}`);
}

function stat(page: Page, label: string): Locator {
  return page
    .locator('dl.stats > div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}

function section(page: Page, headingId: string): Locator {
  return page.locator(`section[aria-labelledby="${headingId}"]`);
}

function prefRow(page: Page, title: string): Locator {
  return page
    .locator('li.pref-row')
    .filter({ has: page.locator('.pref-title', { hasText: new RegExp(`^${title}$`) }) });
}

function sessionRow(table: Locator, title: string): Locator {
  return table
    .locator('tbody tr')
    .filter({ has: table.page().locator('th', { hasText: new RegExp(`^${title}`) }) });
}

/** Cell texts of a table row (th + td), trimmed. */
async function rowCells(row: Locator): Promise<string[]> {
  const cells = await row.locator('th, td').allInnerTexts();
  return cells.map((cell) => cell.replace(/\s+/g, ' ').trim());
}

/** Width ratio of an element to a reference element (layout regression checks). */
async function widthRatio(element: Locator, reference: Locator): Promise<number> {
  const a = await element.boundingBox();
  const b = await reference.boundingBox();
  if (a === null || b === null || b.width === 0) {
    return Number.NaN;
  }
  return a.width / b.width;
}

async function countdownSeconds(page: Page): Promise<number> {
  const text = (await statusCard(page, 'offered').locator('.countdown').innerText()).trim();
  const match = /^(\d+):(\d\d)$/.exec(text);
  if (match === null) {
    return text === 'expired' ? 0 : Number.NaN;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

async function signIn(
  key: ActorKey,
  trigger: Locator,
  returnPath: string,
  screenshot?: string,
): Promise<void> {
  const person = actor(key);
  const { page } = person;
  await click(trigger);
  await signInWithHostedUi(page, person.email, opts.password, {
    typeDelayMs: opts.typeDelay,
    beforeSubmit: async () => {
      if (screenshot !== undefined) {
        await shot(
          key,
          screenshot,
          `Cognito hosted UI (classic): ${person.label} signs in with e-mail and password`,
        );
      }
      await beat(0.5);
    },
  });
  await page.waitForURL((url) => url.origin === opts.web && url.pathname === returnPath, {
    timeout: 30_000,
  });
  await expect(page.locator('.topbar .user-email')).toHaveText(person.displayName, {
    timeout: 15_000,
  });
  const stored = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((name) => name.startsWith('oidc.user:')),
  );
  const trace = oidc.get(key);
  check(
    `${person.label}: authorization request = code flow with PKCE (S256), scopes openid email profile`,
    trace?.authorize?.responseType === 'code' &&
      trace.authorize.method === 'S256' &&
      trace.authorize.challenge &&
      trace.authorize.scope === 'openid email profile',
    JSON.stringify(trace?.authorize),
  );
  check(
    `${person.label}: token request = authorization_code grant with a code_verifier`,
    trace?.token?.grantType === 'authorization_code' && trace.token.verifier,
    JSON.stringify(trace?.token),
  );
  check(
    `${person.label}: OIDC user stored in localStorage after the callback`,
    stored.length === 1,
    stored.join(','),
  );
  check(
    `${person.label}: back on ${returnPath} without code/state in the address bar`,
    !page.url().includes('code=') && !page.url().includes('state='),
    page.url(),
  );
}

// ---------------------------------------------------------------------------------------------
// The flow

interface Ctx {
  orgName: string;
  workshopTitle: string;
  publicUrl: string;
  dashboardUrl: string;
  workshopId: string;
}

const ctx: Ctx = {
  orgName: '',
  workshopTitle: '',
  publicUrl: '',
  dashboardUrl: '',
  workshopId: '',
};

/**
 * Reads `/env.js` and `GET /health` through a throwaway browser page rather than Node's fetch:
 * the browser uses the machine's proxy settings exactly as the walkthrough's pages do.
 */
async function preflight(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const readText = async (url: string): Promise<string> => {
    const response = await page.goto(url, { waitUntil: 'load' });
    if (response === null || !response.ok()) {
      throw new Error(`GET ${url} → ${response?.status() ?? 'no response'}`);
    }
    return response.text();
  };
  const envJs = await readText(`${opts.web}/env.js`);
  const api = /apiBaseUrl:\s*'([^']+)'/.exec(envJs)?.[1];
  const hosted = /hostedUiDomain:\s*'([^']+)'/.exec(envJs)?.[1];
  const stage = /stage:\s*'([^']+)'/.exec(envJs)?.[1];
  check(
    'env.js names the API, the hosted UI and the stage',
    api !== undefined && hosted !== undefined && stage === opts.stage,
    `${api} ${hosted} ${stage}`,
  );
  apiOrigin = new URL(api as string).origin;
  hostedUiOrigin = new URL(hosted as string).origin;
  const health = JSON.parse(await readText(`${apiOrigin}/health`)) as {
    ok: boolean;
    stage: string;
    time: string;
  };
  await context.close();
  check(
    `API /health ok on stage ${opts.stage}`,
    health.ok && health.stage === opts.stage,
    JSON.stringify(health),
  );
  facts.api = apiOrigin;
  facts.hostedUi = hostedUiOrigin;
}

async function organiserSetsUp(browser: Browser): Promise<void> {
  const org = await startActor(browser, 'organiser');
  const { page } = org;
  const stamp = new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  ctx.orgName = `Staged walkthrough ${stamp}`;
  ctx.workshopTitle = 'Cloud Computing Workshop (staged demo)';

  await step('organiser signs in through the hosted UI', async () => {
    director.cut(
      'organiser',
      'Opens SeatRelay (dev stage) and signs in through the Cognito hosted UI',
    );
    await page.goto(`${opts.web}/`);
    await expect(
      page.getByRole('heading', { name: 'One queue, many sessions, no double holds.' }),
    ).toBeVisible();
    await expect(page.locator('.badge-stage')).toHaveText(opts.stage);
    await beat();
    await shot('organiser', 'home-signed-out', 'Home page before sign-in (stage badge "dev")');
    await signIn(
      'organiser',
      page.locator('.hero').getByRole('button', { name: 'Sign in' }),
      '/',
      'hosted-ui-sign-in',
    );
    await expect(page.getByText(`Signed in as ${org.email}`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My registrations' })).toBeVisible({
      timeout: 15_000,
    });
    const organisersCard = section(page, 'org-heading');
    const stretch = await widthRatio(
      organisersCard.getByRole('link', { name: 'Go to the organiser area' }),
      organisersCard,
    );
    check(
      'layout: "Go to the organiser area" keeps its own width (not stretched across the card)',
      stretch < 0.6,
      `width ratio ${stretch.toFixed(2)}`,
    );
    await beat();
    await shot(
      'organiser',
      'home-signed-in',
      'Back from the hosted UI: signed in (name from the ID token in the top bar)',
    );
  });

  await step('organiser creates an organisation', async () => {
    director.cut('organiser', 'Creates an organisation');
    await click(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Organiser' }),
    );
    await expect(page.getByRole('heading', { name: 'Organiser area' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My organisations' })).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('#org-name').pressSequentially(ctx.orgName, { delay: opts.typeDelay });
    await click(page.getByRole('button', { name: 'Create', exact: true }));
    const row = page
      .locator('li.card')
      .filter({ has: page.getByRole('heading', { name: ctx.orgName, exact: true }) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await scrollToTop(page, row);
    await beat();
    await shot('organiser', 'organisation-created', 'Organiser area: the new organisation');
    await click(row.getByRole('link', { name: 'Workshops' }));
    await expect(page.getByRole('heading', { name: 'Organisation workshops' })).toBeVisible();
    await expect(page.getByText('No workshop yet.')).toBeVisible({ timeout: 15_000 });
  });

  await step('organiser creates a workshop with three sessions', async () => {
    director.cut(
      'organiser',
      `Creates a workshop: unified queue, ${HOLD_SECONDS} s hold, 3 sessions (capacities ${CAPACITIES.join(' / ')})`,
    );
    const wizard = section(page, 'wizard-heading');
    await scrollToTop(page, wizard);
    await page.locator('#ws-title').pressSequentially(ctx.workshopTitle, { delay: opts.typeDelay });
    await page
      .locator('#ws-desc')
      .fill(
        'Staged walkthrough on the dev stack: three sessions of the same workshop, one seat each in Sessions 2 and 3.',
      );
    await page.locator('#ws-mode').selectOption('UNIFIED');
    await page.locator('#ws-hold').fill(String(HOLD_SECONDS));
    const selectBox = await page.locator('#ws-mode').boundingBox();
    const holdBox = await page.locator('#ws-hold').boundingBox();
    const offset = Math.abs((selectBox?.y ?? 0) - (holdBox?.y ?? 1000));
    check(
      'layout: wizard step 1, the Mode select and the Hold input are top-aligned',
      offset <= 3,
      `offset ${offset.toFixed(1)} px`,
    );
    await beat();
    await shot(
      'organiser',
      'wizard-basics',
      'Create-workshop wizard, step 1: title, mode UNIFIED, hold 60 s',
    );
    await click(wizard.getByRole('button', { name: 'Next' }));
    await click(wizard.getByRole('button', { name: 'Add session' }));
    const rows = wizard.locator('fieldset.session-row');
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await rows
        .nth(i)
        .getByLabel('Starts (local time)')
        .fill(SESSION_STARTS[i] as string);
      await rows.nth(i).getByLabel('Capacity').fill(String(CAPACITIES[i]));
    }
    const addRatio = await widthRatio(wizard.getByRole('button', { name: 'Add session' }), wizard);
    check(
      'layout: "Add session" keeps its own width',
      addRatio < 0.5,
      `width ratio ${addRatio.toFixed(2)}`,
    );
    await scrollToTop(page, wizard);
    await beat();
    await shot(
      'organiser',
      'wizard-sessions',
      'Wizard step 2: three sessions with small capacities',
    );
    await click(wizard.getByRole('button', { name: 'Next' }));
    await expect(wizard.locator('dl.review')).toContainText('UNIFIED');
    await expect(wizard.locator('dl.review')).toContainText('1 min');
    await beat();
    await shot('organiser', 'wizard-review', 'Wizard step 3: review before creating');
    await click(wizard.getByRole('button', { name: 'Create workshop' }));
    await page.waitForURL(/\/org\/[^/]+\/workshops\/[^/]+$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1, name: ctx.workshopTitle })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.page-header .muted').first()).toContainText('UNIFIED · hold 1 min');
    const table = section(page, 'sessions-heading');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      const cells = await rowCells(sessionRow(table, `Session ${i + 1}`));
      // Session, Status, Capacity, Confirmed, Held, Free, Waiting, Manage
      check(
        `Session ${i + 1}: capacity ${CAPACITIES[i]}, nothing held, all free`,
        cells[2] === String(CAPACITIES[i]) &&
          cells[3] === '0' &&
          cells[4] === '0' &&
          cells[5] === String(CAPACITIES[i]) &&
          cells[6] === '0',
        cells.slice(0, 7).join(' | '),
      );
    }
    ctx.dashboardUrl = page.url();
    ctx.workshopId = decodeURIComponent(page.url().split('/').pop() as string);
    ctx.publicUrl = await page.getByLabel('Share link (public page)').inputValue();
    check(
      'share link points at the public workshop page',
      ctx.publicUrl === `${opts.web}/workshops/${encodeURIComponent(ctx.workshopId)}`,
      ctx.publicUrl,
    );
    facts.workshopId = ctx.workshopId;
    facts.orgName = ctx.orgName;
    const editRatio = await widthRatio(
      page.getByRole('button', { name: 'Edit details' }),
      page.locator('main'),
    );
    check(
      'layout: "Edit details" keeps its own width',
      editRatio < 0.5,
      `width ratio ${editRatio.toFixed(2)}`,
    );
    const cancelSession = sessionRow(table, 'Session 1').getByRole('button', {
      name: 'Cancel session',
    });
    const cancelRatio = await widthRatio(
      cancelSession,
      sessionRow(table, 'Session 1').locator('td').last(),
    );
    check(
      'layout: "Cancel session" keeps its own width in the Manage cell',
      cancelRatio < 0.8,
      `width ratio ${cancelRatio.toFixed(2)}`,
    );
    await scrollTop(page);
    await beat();
    await shot(
      'organiser',
      'dashboard-new',
      'Dashboard of the new workshop: three sessions, nothing allocated yet',
    );
  });
}

async function participantSignsIn(
  browser: Browser,
  key: ActorKey,
  screenshotPublic?: string,
): Promise<Actor> {
  const person = await startActor(browser, key);
  const { page } = person;
  await page.goto(ctx.publicUrl);
  await expect(page.getByRole('heading', { level: 1, name: ctx.workshopTitle })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: 'Want a seat?' })).toBeVisible();
  const panel = page.locator('section.panel-center');
  const panelBox = await panel.boundingBox();
  const buttonBox = await panel.getByRole('button', { name: 'Sign in to register' }).boundingBox();
  const drift =
    panelBox === null || buttonBox === null
      ? Number.NaN
      : Math.abs(buttonBox.x + buttonBox.width / 2 - (panelBox.x + panelBox.width / 2));
  check(
    `layout: ${person.label}'s "Sign in to register" stays centred in its panel`,
    drift <= 4,
    `${drift.toFixed(1)} px off centre`,
  );
  await beat(0.6);
  if (screenshotPublic !== undefined) {
    await shot(
      key,
      screenshotPublic,
      'Public workshop page before sign-in: sessions, free seats, queue length',
    );
  }
  const path = new URL(ctx.publicUrl).pathname;
  await signIn(key, page.getByRole('button', { name: 'Sign in to register' }), path);
  await expect(page.getByRole('heading', { name: 'Register' })).toBeVisible({ timeout: 15_000 });
  return person;
}

async function register(
  key: ActorKey,
  titles: readonly string[],
  buttonName: string,
): Promise<number> {
  const { page } = actor(key);
  for (const title of titles) {
    await click(prefRow(page, title).locator('input[type="checkbox"]'), 250);
  }
  await beat(0.5);
  const sentAt = Date.now();
  await click(page.getByRole('button', { name: buttonName }));
  return sentAt;
}

async function aliceRegistersAndAccepts(browser: Browser): Promise<void> {
  await step('Alice signs in from the share link', async () => {
    director.cut('alice', 'Opens the share link and signs in to register');
    await participantSignsIn(browser, 'alice', 'public-page-signed-out');
  });
  const { page } = actor('alice');

  await step('Alice picks two sessions and orders them', async () => {
    director.cut(
      'alice',
      'Ticks Session 1, then Session 2, and moves Session 2 up: her first choice',
    );
    for (const title of ['Session 1', 'Session 2']) {
      await click(prefRow(page, title).locator('input[type="checkbox"]'), 250);
    }
    let order = await page.locator('li.pref-row.pref-selected .pref-title').allInnerTexts();
    check(
      'tick order sets the ranks: Session 1 = 1, Session 2 = 2',
      order.join(',') === 'Session 1,Session 2',
      order.join(','),
    );
    await beat(0.6);
    await click(page.getByRole('button', { name: 'Move Session 2 up' }));
    order = await page.locator('li.pref-row.pref-selected .pref-title').allInnerTexts();
    const ranks = await page.locator('li.pref-row.pref-selected .rank').allInnerTexts();
    check(
      '▲ moves Session 2 to rank 1',
      order.join(',') === 'Session 2,Session 1' && ranks.join(',') === '1,2',
      `${order.join(',')} / ${ranks.join(',')}`,
    );
    await expect(page.getByRole('button', { name: 'Move Session 2 up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move Session 1 down' })).toBeDisabled();
    await scrollTop(page);
    await beat();
    await shot(
      'alice',
      'register-preferences',
      'Registration form: two acceptable sessions in preference order (1 = Session 2)',
    );
  });

  await step('Alice registers: request received, then a held seat with a countdown', async () => {
    director.cut(
      'alice',
      'Registers: request accepted at once (202), the page polls until the seat is decided',
    );
    const sentAt = Date.now();
    await click(page.getByRole('button', { name: 'Register (2 sessions)' }), 300);
    const received = page.getByText('Request received, waiting for the outcome…');
    try {
      await received.waitFor({ state: 'visible', timeout: 4_000 });
      await shot(
        'alice',
        'request-received',
        '"Request received": the 202 came back, the outcome is not known yet (polling)',
      );
    } catch {
      observations.push(
        'The "Request received" line was not visible long enough for a screenshot (the command settled within the first poll).',
      );
    }
    await expect(statusCard(page, 'offered')).toBeVisible({ timeout: 30_000 });
    await expect(toast(page, 'Registration applied')).toBeVisible({ timeout: 10_000 });
    await expect(statusCard(page, 'offered')).toContainText('A seat in Session 2');
    await expect(statusCard(page, 'offered')).toContainText('is held for you');
    const seconds = await countdownSeconds(page);
    check(
      'countdown shows the 60 s hold (between 0:30 and 1:00)',
      seconds > 30 && seconds <= 60,
      `${seconds} s`,
    );
    await expect(statusCard(page, 'offered')).toContainText(
      'Preference order: 1. Session 2 · 2. Session 1',
    );
    const sending = events.find(
      (e) =>
        e.actor === 'alice' &&
        e.at >= sentAt - 50 &&
        e.kind === 'toast' &&
        e.text.startsWith('Sending'),
    );
    const offered = events.find(
      (e) =>
        e.actor === 'alice' && e.at >= sentAt - 50 && e.kind === 'card' && e.text === 'offered',
    );
    if (sending !== undefined && offered !== undefined) {
      facts.aliceClickToOfferMs = offered.at - sending.at;
    }
    const seq = events
      .filter((e) => e.actor === 'alice' && e.at >= sentAt - 50)
      .map((e) => `${e.kind}:${e.text}`);
    const iReceived = seq.findIndex((entry) => entry.includes('Request received'));
    const iApplied = seq.findIndex((entry) => entry.startsWith('toast:Registration applied'));
    check(
      'visible order: "Request received" before "Registration applied"',
      iReceived >= 0 && iApplied > iReceived,
      seq.slice(0, 8).join(' → '),
    );
    await beat(1.2);
    await shot(
      'alice',
      'offer-countdown',
      'Seat held in Session 2 (her first choice) with the live countdown; toast "Registration applied"',
    );
  });

  await step('Alice accepts', async () => {
    director.cut('alice', 'Accepts: seat confirmed');
    await click(page.getByRole('button', { name: 'Accept seat' }));
    await expect(statusCard(page, 'confirmed')).toBeVisible({ timeout: 30_000 });
    await expect(statusCard(page, 'confirmed')).toContainText('Seat confirmed in Session 2');
    await expect(toast(page, 'Accept applied')).toBeVisible({ timeout: 10_000 });
    await beat(1.2);
    await shot('alice', 'confirmed', 'Seat confirmed; "Cancel my seat" is the only action left');
  });
}

async function bobQueues(browser: Browser): Promise<void> {
  await step('Bob registers for the full session and is queued', async () => {
    director.cut('bob', 'Signs in, registers for Session 2 only: it is full, so he is queued');
    const { page } = await participantSignsIn(browser, 'bob');
    const table = page.locator('.table-wrap table').first();
    const before = await rowCells(sessionRow(table, 'Session 2'));
    // Session, Starts, Status, Capacity, Free, Waiting
    check(
      'public table: Session 2 has 0 free before Bob registers',
      before[4] === '0',
      before.join(' | '),
    );
    await register('bob', ['Session 2'], 'Register (1 session)');
    await expect(statusCard(page, 'queued')).toBeVisible({ timeout: 30_000 });
    await expect(statusCard(page, 'queued')).toContainText('Queued at position 1');
    await expect(toast(page, 'Registration applied')).toContainText(
      'You are queued at position 1.',
    );
    await expect(sessionRow(table, 'Session 2').locator('td').nth(4)).toHaveText('1', {
      timeout: 15_000,
    });
    await expect(
      page.getByText('This page refreshes every 10 s while you are queued or offered'),
    ).toBeVisible();
    await beat(1.2);
    await shot(
      'bob',
      'queued',
      'Bob is queued at position 1 for Session 2; the page refreshes every 10 s while queued',
    );
  });
}

async function aliceCancelsBobGetsBackfill(): Promise<void> {
  const alice = actor('alice').page;
  const bob = actor('bob').page;
  let cancelSettledAt = 0;

  await step('Alice cancels her confirmed seat', async () => {
    director.cut('alice', 'Her plans change: she cancels her confirmed seat');
    await scrollTop(alice);
    await click(alice.getByRole('button', { name: 'Cancel my seat' }));
    await expect(alice.getByText('Release your seat?')).toBeVisible();
    await beat();
    await shot('alice', 'cancel-confirm', 'Cancelling asks for confirmation inline');
    await click(alice.getByRole('button', { name: 'Yes, cancel' }));
    await expect(toast(alice, 'Cancellation applied')).toBeVisible({ timeout: 30_000 });
    cancelSettledAt = Date.now();
    await expect(toast(alice, 'Cancellation applied')).toContainText(
      'Your registration is cancelled.',
    );
    // The page keeps a status card that says what happened, instead of the empty form.
    await expect(statusCard(alice, 'cancelled')).toContainText(
      'You gave up your confirmed seat in Session 2',
      { timeout: 15_000 },
    );
    await expect(alice.getByRole('button', { name: 'Register again' })).toBeVisible();
    await expect(alice.getByRole('heading', { name: 'Register', exact: true })).toHaveCount(0);
    await beat(1.2);
    await shot(
      'alice',
      'cancelled',
      'After the cancellation the page says what happened and offers "Register again"',
    );
  });

  await step("Bob's status page picks up the backfill on its 10 s refresh", async () => {
    director.cut(
      'bob',
      'His page refreshes every 10 s while queued: the freed seat is now held for him',
    );
    await scrollTop(bob);
    await expect(statusCard(bob, 'offered')).toBeVisible({ timeout: 25_000 });
    const seenAfter = Date.now() - cancelSettledAt;
    facts.bobSawBackfillAfterMs = seenAfter;
    check(
      'Bob sees the offer without reloading, within one refresh period (+ slack)',
      seenAfter <= 20_000,
      `${seenAfter} ms after the cancellation settled`,
    );
    await expect(statusCard(bob, 'offered')).toContainText('A seat in Session 2');
    const seconds = await countdownSeconds(bob);
    check("Bob's countdown is running (≤ 60 s)", seconds > 0 && seconds <= 60, `${seconds} s`);
    const expiresAt = await statusCard(bob, 'offered')
      .locator('time.countdown')
      .getAttribute('datetime');
    facts.bobOfferExpiresAt = expiresAt;
    await beat(1.2);
    await shot(
      'bob',
      'offer-after-cancellation',
      "Bob's page, without a reload: the cancelled seat is now held for him",
    );
  });
}

async function carolQueuesBehindBobsOffer(browser: Browser): Promise<void> {
  await step('Carol registers for Session 2 and is queued behind the held seat', async () => {
    director.cut('carol', 'Registers for Session 2: the seat is held for Bob, so she is queued');
    const { page } = await participantSignsIn(browser, 'carol');
    await register('carol', ['Session 2'], 'Register (1 session)');
    await expect(statusCard(page, 'queued')).toBeVisible({ timeout: 30_000 });
    await expect(statusCard(page, 'queued')).toContainText('Queued at position 1');
    await beat(1.2);
    await shot('carol', 'queued', 'Carol is queued at position 1 behind the seat held for Bob');
  });

  await step('dashboard: offer, queue and the cancellation backfill', async () => {
    director.cut(
      'organiser',
      'Dashboard: seat held for Bob, Carol queued, cancellation backfill logged (0 ms)',
    );
    const { page } = actor('organiser');
    await click(page.getByRole('button', { name: 'Refresh' }));
    await expect(section(page, 'offered-heading').getByRole('heading')).toHaveText('Offered (1)', {
      timeout: 15_000,
    });
    await expect(section(page, 'offered-heading')).toContainText('Bob (staged)');
    await expect(section(page, 'queue-heading').getByRole('heading')).toHaveText('Queue (1)');
    await expect(section(page, 'queue-heading')).toContainText('Carol (staged)');
    const log = section(page, 'backfill-heading');
    await expect(log.locator('tbody tr')).toHaveCount(1);
    const cells = await rowCells(log.locator('tbody tr').first());
    // Released, Session, Cause, Reallocated, Latency, New holder (named, like the other tables)
    check(
      'backfill log: Session 2, "confirmed seat cancelled", reallocated to Bob',
      cells[1] === 'Session 2' &&
        cells[2] === 'confirmed seat cancelled' &&
        cells[3] !== 'waiting for a taker' &&
        (cells[5] ?? '').includes('Bob (staged)'),
      cells.join(' | '),
    );
    facts.cancellationBackfillLatency = cells[4];
    await expect(log.locator('.card-header')).toContainText('1/1 reallocated');
    await expect(stat(page, 'Queued')).toHaveText('1');
    await expect(stat(page, 'Offered')).toHaveText('1');
    await expect(stat(page, 'Backfills')).toHaveText('1/1');
    await scrollToTop(page, section(page, 'sessions-heading'));
    await beat(1.2);
    await shot(
      'organiser',
      'dashboard-queue-offer',
      'Dashboard: Carol queued, the seat held for Bob with its countdown, the backfill log',
    );
  });
}

async function bobsHoldExpires(): Promise<void> {
  const bob = actor('bob').page;
  const carol = actor('carol').page;
  const expiresAtIso = facts.bobOfferExpiresAt as string;
  const expiresAt = Date.parse(expiresAtIso);
  let carolOfferedAt = 0;

  await step('Bob does not answer: the 60 s hold runs out', async () => {
    director.cut('bob', 'Does not answer: the 60 s hold runs out', 4);
    await scrollTop(bob);
    const untilShot = expiresAt - Date.now() - 7_000;
    if (untilShot > 0) {
      await sleep(untilShot);
    }
    director.cut('bob', 'The last seconds of the hold');
    await shot('bob', 'offer-expiring', "Bob's hold in its last seconds");
    await expect(statusCard(bob, 'offered')).toHaveCount(0, {
      timeout: Math.max(0, expiresAt - Date.now()) + 40_000,
    });
    // Same meaning as in earlier runs: the offered card is gone (the workshop view has no `me`).
    facts.bobCardGoneAfterExpiryMs = Date.now() - expiresAt;
    await expect(statusCard(bob, 'ended')).toContainText('Your hold for Session 2 expired', {
      timeout: 15_000,
    });
    await expect(bob.getByRole('button', { name: 'Register again' })).toBeVisible();
    // Includes the `GET /me/registrations` round trip(s) that bring the ending.
    facts.bobEndedCardAfterExpiryMs = Date.now() - expiresAt;
    await beat(1.2);
    await shot(
      'bob',
      'after-expiry',
      'After the expiry Bob\'s page says his hold expired and offers "Register again"',
    );
    observations.push(
      `Bob's page around the expiry (status card states): ${events
        .filter((e) => e.actor === 'bob' && e.kind === 'card')
        .map((e) => `${e.text}@${new Date(e.at).toISOString().slice(11, 19)}`)
        .join(' → ')}; offer expiresAt ${expiresAtIso}.`,
    );
  });

  await step("Carol's page picks up the automatic backfill", async () => {
    director.cut(
      'carol',
      'Her page refreshes every 10 s: the expired seat was relayed to her automatically',
      2,
    );
    await scrollTop(carol);
    await expect(statusCard(carol, 'offered')).toBeVisible({
      timeout: Math.max(0, expiresAt - Date.now()) + 45_000,
    });
    carolOfferedAt = Date.now();
    facts.carolSawOfferAfterExpiryMs = carolOfferedAt - expiresAt;
    check(
      'Carol sees the relayed seat within 45 s of the expiry',
      carolOfferedAt - expiresAt <= 45_000,
      `${carolOfferedAt - expiresAt} ms`,
    );
    await expect(statusCard(carol, 'offered')).toContainText('A seat in Session 2');
    director.cut('carol', 'Nobody pressed anything: the seat moved on to her by itself');
    await beat(1.2);
    await shot(
      'carol',
      'offer-after-expiry',
      "Carol's page: the expired seat was relayed to her without anyone acting",
    );
  });

  await step('Carol accepts', async () => {
    director.cut('carol', 'Accepts: seat confirmed');
    await click(carol.getByRole('button', { name: 'Accept seat' }));
    await expect(statusCard(carol, 'confirmed')).toBeVisible({ timeout: 30_000 });
    await expect(statusCard(carol, 'confirmed')).toContainText('Seat confirmed in Session 2');
    await beat(1.2);
    await shot('carol', 'confirmed', 'Carol confirmed in Session 2');
  });
}

async function organiserReviews(): Promise<void> {
  const { page } = actor('organiser');

  await step('dashboard: backfill log, counters, distinct served', async () => {
    director.cut(
      'organiser',
      'Dashboard: both backfills with their latency, distinct participants served',
    );
    await scrollTop(page);
    await click(page.getByRole('button', { name: 'Refresh' }));
    await expect(stat(page, 'Confirmed')).toHaveText('1', { timeout: 15_000 });
    await expect(stat(page, 'Queued')).toHaveText('0');
    await expect(stat(page, 'Offered')).toHaveText('0');
    await expect(stat(page, 'Distinct served')).toHaveText('1');
    await expect(stat(page, 'Backfills')).toHaveText('2/2');
    const log = section(page, 'backfill-heading');
    await expect(log.locator('tbody tr')).toHaveCount(2);
    const rows = await Promise.all([0, 1].map((i) => rowCells(log.locator('tbody tr').nth(i))));
    const expired = rows.find((cells) => cells[2] === 'offer expired');
    const cancelled = rows.find((cells) => cells[2] === 'confirmed seat cancelled');
    check(
      'backfill log lists the expiry and the cancellation, both reallocated, holders named',
      expired !== undefined &&
        cancelled !== undefined &&
        expired[3] !== 'waiting for a taker' &&
        (expired[5] ?? '').includes('Carol (staged)') &&
        (cancelled[5] ?? '').includes('Bob (staged)'),
      rows.map((r) => r.join(' | ')).join(' ;; '),
    );
    facts.expiryBackfillLatency = expired?.[4];
    facts.backfillHeader = await log.locator('.card-header .muted').innerText();
    const table = section(page, 'sessions-heading');
    const s2 = await rowCells(sessionRow(table, 'Session 2'));
    check(
      'Session 2: capacity 1, confirmed 1, held 0, free 0, waiting 0',
      s2[2] === '1' && s2[3] === '1' && s2[4] === '0' && s2[5] === '0' && s2[6] === '0',
      s2.slice(0, 7).join(' | '),
    );
    await scrollToTop(page, log);
    await beat(1.5);
    await shot(
      'organiser',
      'dashboard-backfill-log',
      'Backfill log: cancellation relayed in the same transaction, expiry relayed by the timer path',
    );
  });

  await step('dashboard: attendance tick', async () => {
    director.cut('organiser', 'Ticks attendance for the confirmed participant');
    const confirmed = section(page, 'confirmed-heading');
    await scrollToTop(page, confirmed);
    const row = confirmed.locator('tbody tr').filter({ hasText: 'Carol (staged)' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.attendance label')).toHaveText('Not marked');
    await click(row.locator('.attendance input[type="checkbox"]'));
    await expect(row.locator('.attendance label')).toHaveText('Attended', { timeout: 15_000 });
    await expect(stat(page, 'Attended')).toHaveText('1', { timeout: 15_000 });
    await beat();
    await shot(
      'organiser',
      'dashboard-attendance',
      'Confirmed list with the attendance tick saved',
    );
  });

  await step('dashboard: CSV export and verify invariants', async () => {
    director.cut(
      'organiser',
      'Exports CSV, then "Verify invariants": no over-capacity, no double holds',
    );
    const actions = section(page, 'actions-heading');
    await scrollToTop(page, actions);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      click(actions.getByRole('button', { name: 'Export CSV' })),
    ]);
    const csvPath = join(opts.outDir, download.suggestedFilename());
    await download.saveAs(csvPath);
    const csv = readFileSync(csvPath, 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    check(
      'CSV export downloaded with a header and the participants',
      lines.length >= 2 && csv.includes(`${opts.prefix}-carol@example.com`),
      `${download.suggestedFilename()}: ${lines.length} lines; header ${lines[0]}`,
    );
    facts.csvHeader = lines[0];
    facts.csvLines = lines.length;
    await expect(actions.getByRole('button', { name: 'Downloaded' })).toBeVisible({
      timeout: 5_000,
    });
    await click(actions.getByRole('button', { name: 'Verify invariants' }));
    await expect(actions.locator('.banner-success')).toContainText('All invariants hold', {
      timeout: 20_000,
    });
    await expect(actions.getByRole('button', { name: 'OK — verify again' })).toBeVisible();
    await beat(1.5);
    await shot(
      'organiser',
      'dashboard-verify-ok',
      '"Verify invariants": all invariants hold; CSV downloaded',
    );
    await scrollTop(page);
    await beat(0.5);
    await shot(
      'organiser',
      'dashboard-overview',
      'Dashboard header and counters at the end of the walkthrough',
    );
    await shot(
      'organiser',
      'dashboard-full',
      'The whole dashboard at the end of the walkthrough (full page)',
      true,
    );
  });
}

/** This run's row under *My registrations → Past* (earlier runs reuse the workshop title). */
function pastRow(page: Page): Locator {
  return page
    .locator('section[aria-labelledby="past-heading"] li')
    .filter({ has: page.locator(`a[href="/workshops/${encodeURIComponent(ctx.workshopId)}"]`) });
}

async function participantsLookBack(): Promise<void> {
  await step("Alice's registrations: the cancelled one under Past", async () => {
    director.cut('alice', 'My registrations: her cancelled registration is listed under Past');
    const { page } = actor('alice');
    await click(
      page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'My registrations' }),
    );
    await expect(page.getByRole('heading', { level: 1, name: 'My registrations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Past' })).toBeVisible({ timeout: 15_000 });
    await expect(pastRow(page)).toContainText('cancelled', { timeout: 15_000 });
    facts.alicePastRow = (await pastRow(page).innerText()).replace(/\s+/g, ' ').trim();
    await beat(1.2);
    await shot(
      'alice',
      'my-registrations',
      'My registrations (Alice): the cancelled registration under Past',
    );
  });

  await step("Bob's registrations: the ended one with its reason", async () => {
    director.cut('bob', 'My registrations: his registration ended when the hold expired');
    const { page } = actor('bob');
    await click(
      page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'My registrations' }),
    );
    await expect(page.getByRole('heading', { name: 'Past' })).toBeVisible({ timeout: 15_000 });
    const row = pastRow(page);
    await expect(row).toContainText('ended: your hold on Session 2 expired', { timeout: 15_000 });
    facts.bobPastRow = (await row.innerText()).replace(/\s+/g, ' ').trim();
    await beat(1.2);
    await shot(
      'bob',
      'my-registrations-ended',
      'My registrations (Bob): his registration ended after the hold expired',
    );
  });

  await step("Bob's notifications", async () => {
    director.cut('bob', 'In-app notifications (e-mail is off on dev): the offer, then its expiry');
    const { page } = actor('bob');
    await click(
      page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: /Notifications/ }),
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await beat(2);
    await shot(
      'bob',
      'notifications',
      'Notification centre (Bob): the in-app record of his offer and its expiry',
    );
  });

  await step('Alice signs out (hosted UI logout round trip)', async () => {
    director.cut('alice', 'Signs out: the app forgets her and the hosted UI session ends too');
    const { page } = actor('alice');
    await scrollTop(page);
    await click(page.locator('.topbar').getByRole('button', { name: 'Sign out' }));
    await page.waitForURL((url) => url.origin === opts.web && url.pathname === '/', {
      timeout: 30_000,
    });
    await expect(page.locator('.topbar').getByRole('button', { name: 'Sign in' })).toBeVisible({
      timeout: 15_000,
    });
    const stored = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((name) => name.startsWith('oidc.user:')),
    );
    check(
      'Alice: no OIDC user left in localStorage after sign-out',
      stored.length === 0,
      stored.join(','),
    );
    // /logout cleared the hosted UI's own session: signing in again must ask for the password.
    await click(page.locator('.hero').getByRole('button', { name: 'Sign in' }));
    await page.waitForURL(/\.amazoncognito\.com\/(login|oauth2\/authorize)/, { timeout: 30_000 });
    await expect(
      page.locator('form[name="cognitoSignInForm"]:visible input[name="username"]'),
    ).toBeVisible({ timeout: 15_000 });
    await sleep(1_500);
    check(
      'after sign-out the hosted UI asks for credentials again (no silent sign-in)',
      /amazoncognito\.com/.test(page.url()),
      new URL(page.url()).pathname,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Video, publishing, summary

function ffprobeDuration(path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    {
      encoding: 'utf8',
    },
  );
  return Number(out.trim());
}

async function closeAll(): Promise<void> {
  director.close();
  for (const person of actors.values()) {
    await person.context.close().catch(() => undefined);
    person.closedAt = Date.now();
  }
}

async function cutVideo(): Promise<string | undefined> {
  const sources: VideoSource[] = [];
  for (const person of actors.values()) {
    const video = person.page.video();
    if (video === null) {
      continue;
    }
    const path = await video.path();
    const duration = ffprobeDuration(path);
    const fromClose = (person.closedAt ?? Date.now()) - duration * 1000;
    log(
      `video ${person.key}: ${relative(REPO_ROOT, path)} ${duration.toFixed(1)} s; start by page creation ${new Date(person.createdAt).toISOString()}, by close − duration ${new Date(fromClose).toISOString()} (Δ ${((person.createdAt - fromClose) / 1000).toFixed(2)} s)`,
    );
    sources.push({ actor: person.key, path, startedAt: person.createdAt, duration });
  }
  const clips = planClips(director.segments, sources);
  const textDir = join(opts.outDir, 'captions');
  mkdirSync(textDir, { recursive: true });
  const date = new Date(startedAt).toISOString().slice(0, 10);
  const captionFiles = clips.map((clip, k) => {
    const file = join(textDir, `caption-${String(k).padStart(2, '0')}.txt`);
    writeFileSync(file, `${PEOPLE[clip.actor as ActorKey].label} · ${clip.caption}`);
    return file;
  });
  const labelFiles = clips.map((clip, k) => {
    const file = join(textDir, `label-${String(k).padStart(2, '0')}.txt`);
    writeFileSync(
      file,
      `Staged walkthrough · ${opts.stage} stack · ${date}${clip.speed > 1 ? ` · ${clip.speed}× speed` : ''}`,
    );
    return file;
  });
  const intro = [
    'SeatRelay: staged walkthrough',
    `Deployed ${opts.stage} stack (AWS ap-southeast-1) · recorded ${date} with Playwright in Chromium`,
    'Four test accounts (organiser, Alice, Bob, Carol); every action is staged, no real participants',
    'Each part shows the browser of the person acting; long waits are sped up where marked',
  ].map((line, i) => {
    const file = join(textDir, `intro-${i}.txt`);
    writeFileSync(file, line);
    return file;
  });
  const output = join(opts.outDir, 'backup-demo.mp4');
  const fontFile = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/lato/Lato-Medium.ttf',
  ].find(existsSync);
  if (fontFile === undefined) {
    throw new Error('no font for the caption bar (DejaVuSans)');
  }
  const args = ffmpegArgs(clips, {
    output,
    fontFile,
    captionFiles,
    labelFiles,
    introFiles: intro,
    introSeconds: 5,
    pageWidth: VIEWPORT.width,
    pageHeight: VIEWPORT.height,
    barHeight: 72,
    outputWidth: 1280,
    crf: 28,
  });
  writeFileSync(join(opts.outDir, 'ffmpeg-args.json'), JSON.stringify(args, null, 2));
  log(`cutting ${clips.length} clips (${cutLength(clips).toFixed(0)} s + 5 s intro)`);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  const mb = statSync(output).size / 1e6;
  const length = ffprobeDuration(output);
  facts.videoSeconds = Math.round(length);
  facts.videoMb = Math.round(mb * 10) / 10;
  check(
    `video ≤ ${opts.maxVideoMb} MB`,
    mb <= opts.maxVideoMb,
    `${mb.toFixed(1)} MB, ${length.toFixed(0)} s`,
  );
  writeFileSync(
    join(opts.outDir, 'chapters.txt'),
    clips
      .reduce<{ at: number; lines: string[] }>(
        (acc, clip) => {
          const t = acc.at;
          acc.lines.push(
            `${Math.floor(Math.round(t) / 60)}:${String(Math.round(t) % 60).padStart(2, '0')}  ${PEOPLE[clip.actor as ActorKey].label} · ${clip.caption}`,
          );
          acc.at += clip.duration / clip.speed;
          return acc;
        },
        {
          at: 5,
          lines: [
            '# Chapters of backup-demo.mp4 (staged walkthrough; times rounded, about ±1 s)',
            '0:00  Intro card',
          ],
        },
      )
      .lines.join('\n') + '\n',
  );
  return output;
}

function publish(video: string | undefined): void {
  mkdirSync(opts.screenshotsDir, { recursive: true });
  for (const file of readdirSync(opts.screenshotsDir)) {
    if (/^\d\d-.+\.png$/.test(file)) {
      rmSync(join(opts.screenshotsDir, file));
    }
  }
  for (const s of shots) {
    copyFileSync(join(opts.outDir, 'screenshots', s.file), join(opts.screenshotsDir, s.file));
  }
  writeFileSync(
    join(opts.screenshotsDir, 'README.md'),
    [
      '# Walkthrough screenshots',
      '',
      `Captured by \`tools/e2e/src/walkthrough.ts\` on ${new Date(startedAt).toISOString().slice(0, 10)} against the deployed **${opts.stage}** stack`,
      `(${opts.web}), Chromium, 1440×900, light theme. **Staged:** test accounts whose names say "(staged)",`,
      'scripted actions; not user evidence. Regenerate with `pnpm --filter @seatrelay/e2e walkthrough`.',
      '',
      '| File | Window | Shows |',
      '|---|---|---|',
      ...shots.map((s) => `| \`${s.file}\` | ${PEOPLE[s.actor].label} | ${s.caption} |`),
      '',
    ].join('\n'),
  );
  if (video !== undefined) {
    mkdirSync(dirname(opts.videoPath), { recursive: true });
    copyFileSync(video, opts.videoPath);
    copyFileSync(
      join(opts.outDir, 'chapters.txt'),
      join(dirname(opts.videoPath), 'backup-demo-chapters.txt'),
    );
  }
  log(
    `published ${shots.length} screenshots to ${relative(REPO_ROOT, opts.screenshotsDir)}${video !== undefined ? ` and the video to ${relative(REPO_ROOT, opts.videoPath)}` : ''}`,
  );
}

function pollGaps(actorKey: ActorKey, from: number, to: number, pattern: RegExp): number[] {
  const times = net
    .filter(
      (entry) =>
        entry.actor === actorKey &&
        entry.method === 'GET' &&
        pattern.test(entry.path) &&
        entry.at >= from &&
        entry.at <= to,
    )
    .map((entry) => entry.at)
    .sort((a, b) => a - b);
  return times.slice(1).map((t, i) => t - (times[i] as number));
}

function summarise(ok: boolean, error?: unknown): void {
  const finishedAt = Date.now();
  // Every command the browsers sent: POST → 202 time, then the GET /commands/{id} polls (offsets
  // from the 202) until the poll that saw the terminal state.
  const commands = net
    .filter((entry) => entry.method === 'POST' && entry.commandId !== undefined)
    .map((post) => {
      const accepted = post.at + (post.ms ?? 0);
      const polls = net
        .filter((entry) => entry.method === 'GET' && entry.path === `/commands/${post.commandId}`)
        .map((entry) => entry.at - accepted);
      return {
        actor: post.actor,
        type: post.commandType,
        status: post.status,
        postMs: post.ms,
        pollOffsetsMs: polls,
      };
    });
  const commandPolls = commands.map(
    (c) =>
      `${c.actor} ${c.type}: 202 in ${c.postMs} ms, polls at +${c.pollOffsetsMs.join(', +')} ms`,
  );
  const bobRefresh = pollGaps('bob', startedAt, finishedAt, /^\/workshops\/[^/]+$/).filter(
    (gap) => gap > 5_000 && gap < 15_000,
  );
  const apiErrors = net.filter(
    (entry) =>
      entry.host === new URL(apiOrigin || 'http://x').hostname &&
      (entry.status === undefined || entry.status >= 400),
  );
  const meta = {
    script: 'tools/e2e/src/walkthrough.ts',
    verdict: ok ? 'PASS' : 'FAIL',
    staged: true,
    stage: opts.stage,
    web: opts.web,
    api: apiOrigin,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    seconds: Math.round((finishedAt - startedAt) / 1000),
    commit: gitInfo(),
    browser: facts.browser,
    accounts: [...actors.values()].map((a) => ({
      who: a.label,
      email: a.email,
      displayName: a.displayName,
    })),
    facts,
    commands,
    statusPageRefreshGapsMs: bobRefresh,
    checks: {
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    },
    apiErrors,
    consoleErrors,
    observations,
    error: error === undefined ? undefined : String(error instanceof Error ? error.message : error),
  };
  writeFileSync(join(opts.outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(opts.outDir, 'events.json'),
    JSON.stringify({ events, net, segments: director.segments }, null, 2),
  );
  writeFileSync(join(opts.outDir, 'run.log'), logLines.join('\n') + '\n');
  const md = [
    `# web-walkthrough — real-browser walkthrough of the ${opts.stage} stack`,
    '',
    '**Staged walkthrough with test accounts: operational evidence that the deployed web app works end to end in a real browser; not user evidence.**',
    '',
    `- Verdict: **${meta.verdict}** (${meta.checks.passed} explicit checks passed${meta.checks.failed > 0 ? `, ${meta.checks.failed} failed` : ''}; every visible state asserted with Playwright)`,
    `- Started ${meta.startedAt}, finished ${meta.finishedAt} (${meta.seconds} s)`,
    `- Web ${opts.web} → API ${apiOrigin}; Cognito hosted UI ${hostedUiOrigin}; browser ${String(facts.browser ?? '')}`,
    `- Commit: ${meta.commit}`,
    `- Script: \`tools/e2e/src/walkthrough.ts\`; screenshots \`docs/demo/screenshots/\`; video \`docs/demo/backup-demo.mp4\``,
    '',
    '## What was staged',
    '',
    `- Organisation **${ctx.orgName}**, workshop **${ctx.workshopTitle}** (\`${ctx.workshopId}\`), UNIFIED, hold ${HOLD_SECONDS} s, Sessions 1–3 with capacities ${CAPACITIES.join(' / ')}; created through the UI wizard.`,
    '- Alice: Session 2 > Session 1 (ordered with ▲) → offered Session 2 → accepted → cancelled. Bob: Session 2 only → queued → offered by the cancellation backfill → left to expire. Carol: Session 2 only → queued → offered by the expiry backfill → accepted → attendance ticked. CSV export, verify.',
    '',
    '## Observed in the browser',
    '',
    `- OIDC: authorization code + PKCE through the hosted UI for all ${actors.size} accounts; each returned to the page it started from with the user in localStorage and no code/state left in the address bar.`,
    `- Alice's REGISTER: ${String(facts.aliceClickToOfferMs ?? '?')} ms from "Sending…" to the offer card (POST → 202 → polls). Every command (offsets of each GET /commands/{id} from the 202):`,
    ...commandPolls.map((line) => `  - ${line}`),
    `- Sign-in: hosted UI round trip for all ${actors.size} accounts; sign-out cleared the stored user and the hosted UI asked for the password again.`,
    `- Bob's Past entry: "${String(facts.bobPastRow ?? '')}".`,
    `- Cancellation backfill: dashboard latency ${String(facts.cancellationBackfillLatency ?? '?')}; Bob's page showed the offer ${String(facts.bobSawBackfillAfterMs ?? '?')} ms after the cancellation settled (10 s refresh; observed refresh gaps ${bobRefresh.slice(0, 6).join(', ')} ms).`,
    `- Expiry backfill: dashboard latency ${String(facts.expiryBackfillLatency ?? '?')}; Carol's page showed the relayed offer ${String(facts.carolSawOfferAfterExpiryMs ?? '?')} ms after \`expiresAt\`.`,
    `- Backfill log header: "${String(facts.backfillHeader ?? '')}". CSV: ${String(facts.csvLines ?? '?')} lines, header \`${String(facts.csvHeader ?? '')}\`.`,
    `- API responses ≥ 400 or failed: ${apiErrors.length}; console errors: ${consoleErrors.length}.`,
    ...(observations.length > 0 ? ['', '## Notes', '', ...observations.map((o) => `- ${o}`)] : []),
    ...(error !== undefined
      ? [
          '',
          '## Failure',
          '',
          '```',
          String(error instanceof Error ? (error.stack ?? error.message) : error),
          '```',
        ]
      : []),
    '',
    '## Checks',
    '',
    '| step | check | ok | detail |',
    '|---|---|---|---|',
    ...checks.map(
      (c) =>
        `| ${c.step} | ${c.what} | ${c.ok ? 'yes' : '**no**'} | ${(c.detail ?? '').replace(/\|/g, '/')} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(opts.outDir, 'summary.md'), md);
  if (ok && opts.results) {
    const base = join(
      REPO_ROOT,
      'results',
      `${meta.startedAt.slice(0, 10)}-web-walkthrough-${opts.stage}`,
    );
    let dir = base;
    for (let n = 2; existsSync(dir); n += 1) {
      dir = `${base}-${n}`;
    }
    mkdirSync(dir, { recursive: true });
    for (const file of ['summary.md', 'meta.json', 'run.log']) {
      copyFileSync(join(opts.outDir, file), join(dir, file));
    }
    log(`evidence written to ${relative(REPO_ROOT, dir)}`);
  }
}

function gitInfo(): string {
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
        .length > 0;
    return `${hash}${dirty ? ' (dirty)' : ''}`;
  } catch {
    return 'unknown';
  }
}

async function failureScreens(): Promise<string[]> {
  const dir = join(opts.outDir, 'failures');
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const person of actors.values()) {
    const file = join(
      dir,
      `${currentStep.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${person.key}.png`,
    );
    try {
      await person.page.screenshot({ path: file, fullPage: true });
      files.push(file);
    } catch {
      // page already gone
    }
  }
  return files;
}

async function main(): Promise<void> {
  log(
    `walkthrough of ${opts.web} (stage ${opts.stage}), accounts ${opts.prefix}-*, output ${relative(REPO_ROOT, opts.outDir)}`,
  );
  const { browser, executablePath } = await launchChromium({ headed: opts.headed });
  facts.browser = `${browser.version()} (${executablePath})`;
  log(`browser ${String(facts.browser)}`);
  let ok = false;
  let failure: unknown;
  try {
    await step('preflight', () => preflight(browser));
    await organiserSetsUp(browser);
    await aliceRegistersAndAccepts(browser);
    await bobQueues(browser);
    await aliceCancelsBobGetsBackfill();
    await carolQueuesBehindBobsOffer(browser);
    await bobsHoldExpires();
    await organiserReviews();
    await participantsLookBack();
    ok = true;
  } catch (error) {
    failure = error;
    const files = await failureScreens();
    console.error(
      `\n*** WALKTHROUGH FAILED in step "${currentStep}" ***\n${error instanceof Error ? error.message : String(error)}`,
    );
    for (const file of files) {
      console.error(`  screenshot: ${file}`);
    }
    observations.push(
      `Failed in step "${currentStep}"; screenshots: ${files.map((f) => relative(REPO_ROOT, f)).join(', ')}`,
    );
  }
  await closeAll();
  await browser.close();
  let video: string | undefined;
  if (ok && opts.video) {
    try {
      video = await cutVideo();
    } catch (error) {
      ok = false;
      failure = error;
      console.error(`video cut failed: ${String(error)}`);
    }
  }
  if (ok && opts.publish) {
    publish(video);
  }
  summarise(ok, failure);
  log(
    `${ok ? 'PASS' : 'FAIL'}: ${checks.filter((c) => c.ok).length} checks passed; output in ${relative(REPO_ROOT, opts.outDir)}`,
  );
  process.exitCode = ok ? 0 : 1;
}

await main();
