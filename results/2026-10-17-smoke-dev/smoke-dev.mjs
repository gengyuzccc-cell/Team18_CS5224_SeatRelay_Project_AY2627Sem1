// Ad-hoc smoke of the deployed dev stack (plan §3 step 12). Node 22, no deps.
import { randomUUID } from 'node:crypto';
const API = 'https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com';
const TOOL = '203uigcnditpcmp54ir0gnsieq';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
async function token(email) {
  const r = await fetch('https://cognito-idp.ap-southeast-1.amazonaws.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: TOOL, AuthParameters: { USERNAME: email, PASSWORD: 'Passw0rd!' } }),
  });
  const j = await r.json();
  if (!j.AuthenticationResult) throw new Error('auth failed ' + JSON.stringify(j));
  return j.AuthenticationResult.IdToken;
}
async function call(tok, method, path, body) {
  const t0 = Date.now();
  const r = await fetch(API + path, { method, headers: { authorization: tok ? `Bearer ${tok}` : '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, ms: Date.now() - t0 };
}
async function command(tok, wsId, body) {
  const commandId = randomUUID();
  const t0 = Date.now();
  const r = await call(tok, 'POST', `/workshops/${wsId}/commands`, { commandId, ...body });
  if (r.status !== 202) throw new Error(`command ${body.type} -> ${r.status} ${JSON.stringify(r.json)}`);
  for (let i = 0; i < 200; i++) {
    const g = await call(tok, 'GET', `/commands/${commandId}`);
    if (g.json.status && g.json.status !== 'ACCEPTED') return { ...g.json, clientMs: Date.now() - t0, accept202Ms: r.ms };
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('command did not settle');
}
const assert = (c, m) => { if (!c) { throw new Error('ASSERT FAILED: ' + m); } log('PASS', m); };

const [org, alice, bob, carol] = await Promise.all(['organiser', 'alice', 'bob', 'carol'].map((u) => token(`smoke-${u}@example.com`)));
let r = await call(null, 'GET', '/health'); assert(r.status === 200, `GET /health 200 (${r.ms} ms) ${JSON.stringify(r.json)}`);
r = await call(null, 'GET', '/me'); assert(r.status === 401, 'GET /me without token -> 401');
r = await call(org, 'GET', '/me'); assert(r.status === 200, `GET /me 200 ${JSON.stringify(r.json).slice(0, 120)}`);
r = await call(org, 'POST', '/orgs', { name: 'Smoke Org ' + new Date().toISOString() }); assert(r.status === 201 || r.status === 200, `POST /orgs ${r.status}`);
const orgId = r.json.id ?? r.json.organization?.id;
const start = (h) => new Date(Date.now() + h * 3600e3).toISOString();
r = await call(org, 'POST', `/orgs/${orgId}/workshops`, { title: 'Smoke workshop', holdSeconds: 60, sessions: [{ title: 'S1', startsAt: start(48), capacity: 1 }, { title: 'S2', startsAt: start(72), capacity: 1 }] });
assert(r.status === 201 || r.status === 200, `POST workshop ${r.status}`);
const ws = r.json.workshop ?? r.json; const wsId = ws.id; const sessions = r.json.sessions ?? ws.sessions; const [S1, S2] = sessions.map((s) => s.id);
log('workshop', wsId, 'sessions', S1, S2);

let c = await command(alice, wsId, { type: 'REGISTER', acceptable: [S1, S2] });
assert(c.status === 'APPLIED', `alice REGISTER APPLIED (202 in ${c.accept202Ms} ms, settled client-side in ${c.clientMs} ms)`);
let view = (await call(alice, 'GET', `/workshops/${wsId}`)).json;
const aliceOffer = view.me?.currentOffer; assert(view.me?.status === 'OFFERED' && aliceOffer?.sessionId === S1, `alice OFFERED S1 (expiresAt ${aliceOffer?.expiresAt})`);
c = await command(alice, wsId, { type: 'ACCEPT_OFFER', offerId: aliceOffer.id }); assert(c.status === 'APPLIED', `alice ACCEPT APPLIED (${c.clientMs} ms)`);
c = await command(carol, wsId, { type: 'REGISTER', acceptable: [S2] }); assert(c.status === 'APPLIED', 'carol REGISTER S2 (gets S2 offer, keeps it so S2 is full)');
c = await command(bob, wsId, { type: 'REGISTER', acceptable: [S1] }); assert(c.status === 'APPLIED', 'bob REGISTER S1');
view = (await call(bob, 'GET', `/workshops/${wsId}`)).json; assert(view.me?.status === 'QUEUED' && view.me?.queuePosition === 1, `bob QUEUED position ${view.me?.queuePosition}`);
c = await command(alice, wsId, { type: 'CANCEL_REGISTRATION' }); assert(c.status === 'APPLIED', 'alice CANCEL APPLIED');
view = (await call(bob, 'GET', `/workshops/${wsId}`)).json; const bobOffer = view.me?.currentOffer;
assert(view.me?.status === 'OFFERED' && bobOffer?.sessionId === S1, 'bob OFFERED S1 in the same settlement as alice cancel (cancel-driven backfill)');
const dash1 = (await call(org, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`)).json;
log('backfills after cancel', JSON.stringify(dash1.backfills?.map((b) => ({ cause: b.cause, latencyMs: b.latencyMs }))));
const dan = await call(alice, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`); assert(dan.status === 403, 'non-member dashboard -> 403');
// re-register alice behind bob so the expiry of bob's offer backfills to alice
c = await command(alice, wsId, { type: 'REGISTER', acceptable: [S1] }); assert(c.status === 'APPLIED', 'alice re-REGISTER S1 (new seq, queued behind bob)');
const exp = Date.parse(bobOffer.expiresAt); log('waiting for bob offer to expire at', bobOffer.expiresAt);
await new Promise((res) => setTimeout(res, Math.max(0, exp - Date.now() + 200)));
c = await command(bob, wsId, { type: 'ACCEPT_OFFER', offerId: bobOffer.id });
assert(c.status === 'REJECTED' && c.reason === 'OFFER_EXPIRED', `bob ACCEPT at expiresAt+200ms -> ${c.status} ${c.reason}`);
// wait for the timer path to reallocate (it already happened in the tick-first above if the late ACCEPT arrived first)
let aliceState;
for (let i = 0; i < 60; i++) { aliceState = (await call(alice, 'GET', `/workshops/${wsId}`)).json.me; if (aliceState?.status === 'OFFERED') break; await new Promise((res) => setTimeout(res, 1000)); }
assert(aliceState?.status === 'OFFERED', 'alice received the expired seat (expiry-driven backfill)');
const dash = (await call(org, 'GET', `/orgs/${orgId}/workshops/${wsId}/dashboard`)).json;
log('backfills', JSON.stringify(dash.backfills?.map((b) => ({ cause: b.cause, releasedAt: b.releasedAt, reallocatedAt: b.reallocatedAt, latencyMs: b.latencyMs }))));
const ver = (await call(org, 'GET', `/orgs/${orgId}/workshops/${wsId}/verify`)).json; assert(ver.ok === true, `verify ok (${ver.violations?.length ?? 0} violations)`);
const csv = await call(org, 'GET', `/orgs/${orgId}/workshops/${wsId}/export.csv`); assert(csv.status === 200 && String(csv.json).includes(','), `export.csv 200 (${String(csv.json).split('\n').length} lines)`);
console.log(JSON.stringify({ orgId, wsId, backfills: dash.backfills, distinctParticipantsServed: dash.distinctParticipantsServed }, null, 1));
