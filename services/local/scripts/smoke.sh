#!/usr/bin/env bash
# SeatRelay on-prem smoke flow (docs/RUNBOOK.md §3) with curl against the compose stack.
#
#   services/local/scripts/smoke.sh
#
# Environment (defaults match docker-compose.yml):
#   API_BASE            http://localhost:3000
#   KEYCLOAK_BASE       http://localhost:8080      KEYCLOAK_REALM seatrelay   KEYCLOAK_CLIENT tooling
#   SMOKE_PASSWORD      Passw0rd!                  (realm-export.json test users)
#   SMOKE_HOLD_SECONDS  60                         (holdSeconds of the smoke workshop)
#   PG_CONTAINER        seatrelay-local-postgres-1 (empty = skip the "no FAILED rows" check)
#   MAILPIT_BASE        http://localhost:8025      (empty = skip the mail count)
set -euo pipefail

API=${API_BASE:-http://localhost:3000}
KC=${KEYCLOAK_BASE:-http://localhost:8080}
REALM=${KEYCLOAK_REALM:-seatrelay}
CLIENT=${KEYCLOAK_CLIENT:-tooling}
PASSWORD=${SMOKE_PASSWORD:-Passw0rd!}
HOLD=${SMOKE_HOLD_SECONDS:-60}
PG_CONTAINER=${PG_CONTAINER-seatrelay-local-postgres-1}
MAILPIT=${MAILPIT_BASE-http://localhost:8025}

for tool in curl jq python3; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
newid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
now_s() { date +%s; }
iso_now() { python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")'; }
iso_in_hours() { python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(hours=$1)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))"; }

# ID token of a realm user through the password grant of the public `tooling` client.
token() {
  curl -sS -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
    -d grant_type=password -d "client_id=$CLIENT" -d "username=$1" -d "password=$PASSWORD" -d scope=openid \
    | jq -r '.id_token // empty'
}

api() { # method path token [json-body]
  local method=$1 path=$2 tok=$3 body=${4-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' --data "$body"
  else
    curl -sS -X "$method" "$API$path" -H "authorization: Bearer $tok"
  fi
}

# Posts a user command (fresh client commandId) and polls GET /commands/{id} until it settles.
command_settle() { # token wsId body-json -> settled record on stdout
  local tok=$1 ws=$2 body=$3 id accepted record status
  id=$(newid)
  accepted=$(api POST "/workshops/$ws/commands" "$tok" "$(jq -c --arg id "$id" '. + {commandId: $id}' <<<"$body")")
  printf '  POST /workshops/%s/commands %s -> %s\n' "$ws" "$(jq -c '{type}' <<<"$body")" "$(jq -c 'del(.href)' <<<"$accepted")" >&2
  [ "$(jq -r '.status // empty' <<<"$accepted")" = ACCEPTED ] || fail "command not accepted: $accepted"
  for _ in $(seq 1 200); do
    record=$(api GET "/commands/$id" "$tok")
    status=$(jq -r '.status // empty' <<<"$record")
    [ "$status" != ACCEPTED ] && break
    sleep 0.3
  done
  printf '  GET  /commands/%s -> %s\n' "$id" "$(jq -c '{status, reason, result}' <<<"$record")" >&2
  printf '%s' "$record"
}

me_view() { api GET "/workshops/$2" "$1" | jq -c '.me'; }

step "0. ID tokens (password grant, client '$CLIENT' at $KC/realms/$REALM)"
ORG_TOK=$(token organiser@example.com)
ALICE=$(token alice@example.com)
BOB=$(token bob@example.com)
CAROL=$(token carol@example.com)
[ -n "$ORG_TOK" ] && [ -n "$ALICE" ] && [ -n "$BOB" ] && [ -n "$CAROL" ] || fail "could not obtain ID tokens from $KC"
echo "  ok (organiser, alice, bob, carol)"

step "1. organiser creates an organisation and a workshop (2 sessions, capacity 1, holdSeconds $HOLD)"
ORG=$(api POST /orgs "$ORG_TOK" '{"name":"Smoke org"}')
ORG_ID=$(jq -r '.id // empty' <<<"$ORG")
echo "  POST /orgs -> $(jq -c '{id, name, members}' <<<"$ORG")"
[ -n "$ORG_ID" ] || fail "organisation not created: $ORG"
WS=$(api POST "/orgs/$ORG_ID/workshops" "$ORG_TOK" "$(jq -nc --arg a "$(iso_in_hours 24)" --arg b "$(iso_in_hours 26)" --argjson hold "$HOLD" \
  '{title: "Smoke workshop", mode: "UNIFIED", holdSeconds: $hold, sessions: [{title: "S1", startsAt: $a, capacity: 1}, {title: "S2", startsAt: $b, capacity: 1}]}')")
WS_ID=$(jq -r '.workshop.id // empty' <<<"$WS")
S1=$(jq -r '.sessions[0].id // empty' <<<"$WS")
S2=$(jq -r '.sessions[1].id // empty' <<<"$WS")
echo "  POST /orgs/$ORG_ID/workshops -> $(jq -c '{workshop: {id: .workshop.id, status: .workshop.status, holdSeconds: .workshop.holdSeconds}, sessions: [.sessions[] | {id, capacity, cutoffAt}]}' <<<"$WS")"
[ -n "$WS_ID" ] && [ -n "$S1" ] && [ -n "$S2" ] || fail "workshop not created: $WS"

step "2. alice registers (S1, S2) -> OFFER for S1 within one settlement"
R=$(command_settle "$ALICE" "$WS_ID" "$(jq -nc --arg s1 "$S1" --arg s2 "$S2" '{type: "REGISTER", acceptable: [$s1, $s2]}')")
jq -e --arg s1 "$S1" '.status == "APPLIED" and .result.registration.status == "OFFERED" and .result.registration.currentOffer.sessionId == $s1' <<<"$R" >/dev/null \
  || fail "alice expected OFFERED on S1"
ALICE_OFFER=$(jq -r .result.registration.currentOffer.id <<<"$R")

step "3. alice accepts -> CONFIRMED S1; bob registers (S1) -> QUEUED position 1"
R=$(command_settle "$ALICE" "$WS_ID" "$(jq -nc --arg o "$ALICE_OFFER" '{type: "ACCEPT_OFFER", offerId: $o}')")
jq -e --arg s1 "$S1" '.status == "APPLIED" and .result.registration.status == "CONFIRMED" and .result.registration.confirmedSessionId == $s1' <<<"$R" >/dev/null \
  || fail "alice expected CONFIRMED on S1"
R=$(command_settle "$BOB" "$WS_ID" "$(jq -nc --arg s1 "$S1" '{type: "REGISTER", acceptable: [$s1]}')")
jq -e '.status == "APPLIED" and .result.registration.status == "QUEUED" and .result.registration.queuePosition == 1' <<<"$R" >/dev/null \
  || fail "bob expected QUEUED at position 1"

step "4. alice cancels -> bob is OFFERED S1 in the same settlement (backfill CANCELLED_CONFIRMED, latency 0)"
R=$(command_settle "$ALICE" "$WS_ID" '{"type": "CANCEL_REGISTRATION"}')
jq -e '.status == "APPLIED" and .result.offersCreated == 1' <<<"$R" >/dev/null || fail "cancel expected to relay one offer"
BOB_ME=$(me_view "$BOB" "$WS_ID")
echo "  GET  /workshops/$WS_ID (bob) .me -> $BOB_ME"
jq -e --arg s1 "$S1" '.status == "OFFERED" and .currentOffer.sessionId == $s1' <<<"$BOB_ME" >/dev/null || fail "bob expected OFFERED on S1"
BOB_OFFER=$(jq -r .currentOffer.id <<<"$BOB_ME")
BOB_EXPIRES=$(jq -r .currentOffer.expiresAt <<<"$BOB_ME")
DASH=$(api GET "/orgs/$ORG_ID/workshops/$WS_ID/dashboard" "$ORG_TOK")
echo "  GET  .../dashboard .backfills -> $(jq -c '[.backfills[] | {cause, latencyMs, newUserId}]' <<<"$DASH")"
jq -e '(.backfills | length) == 1 and .backfills[0].cause == "CANCELLED_CONFIRMED" and .backfills[0].latencyMs == 0' <<<"$DASH" >/dev/null \
  || fail "expected one CANCELLED_CONFIRMED backfill with latencyMs 0"

step "5. carol registers (S1) and queues; bob lets the offer expire (~$HOLD s) -> carol gets the seat"
R=$(command_settle "$CAROL" "$WS_ID" "$(jq -nc --arg s1 "$S1" '{type: "REGISTER", acceptable: [$s1]}')")
jq -e '.status == "APPLIED" and .result.registration.status == "QUEUED"' <<<"$R" >/dev/null || fail "carol expected QUEUED"
echo "  bob's offer expires at $BOB_EXPIRES; polling carol's view ..."
deadline=$(( $(now_s) + HOLD + 30 ))
while :; do
  CAROL_ME=$(me_view "$CAROL" "$WS_ID")
  [ "$(jq -r '.status // empty' <<<"$CAROL_ME")" = OFFERED ] && break
  [ "$(now_s)" -gt "$deadline" ] && fail "carol was not offered within $((HOLD + 30)) s"
  sleep 1
done
echo "  GET  /workshops/$WS_ID (carol) .me -> $CAROL_ME   (observed at $(iso_now))"
DASH=$(api GET "/orgs/$ORG_ID/workshops/$WS_ID/dashboard" "$ORG_TOK")
echo "  GET  .../dashboard .backfills -> $(jq -c '[.backfills[] | {cause, latencyMs}]' <<<"$DASH")"
jq -e '([.backfills[] | select(.cause == "EXPIRED")] | length) == 1 and ([.backfills[] | select(.cause == "EXPIRED")][0].latencyMs) < 15000' <<<"$DASH" >/dev/null \
  || fail "expected one EXPIRED backfill relayed within 15 s of the expiry"

step "6. bob accepts after expiresAt -> REJECTED (OFFER_EXPIRED)"
R=$(command_settle "$BOB" "$WS_ID" "$(jq -nc --arg o "$BOB_OFFER" '{type: "ACCEPT_OFFER", offerId: $o}')")
jq -e '.status == "REJECTED" and .reason == "OFFER_EXPIRED"' <<<"$R" >/dev/null || fail "late accept expected OFFER_EXPIRED"

step "7. verify -> ok: true; no FAILED rows in the commands queue"
V=$(api GET "/orgs/$ORG_ID/workshops/$WS_ID/verify" "$ORG_TOK")
echo "  GET  .../verify -> $(jq -c . <<<"$V")"
jq -e '.ok == true' <<<"$V" >/dev/null || fail "verify reported violations"
if [ -n "$PG_CONTAINER" ] && command -v docker >/dev/null; then
  FAILED=$(docker exec "$PG_CONTAINER" psql -U seatrelay -d seatrelay -tAc "SELECT count(*) FROM commands WHERE status = 'FAILED'")
  echo "  commands rows with status FAILED: $FAILED"
  [ "$FAILED" = 0 ] || fail "the commands queue has FAILED rows"
fi
if [ -n "$MAILPIT" ]; then
  MAIL=$(curl -sS "$MAILPIT/api/v1/search?query=Smoke%20workshop" 2>/dev/null || true)
  [ -n "$MAIL" ] && echo "  mailpit messages mentioning the workshop: $(jq -r '.messages_count // .total // "?"' <<<"$MAIL") $(jq -c '[.messages[]? | {to: .To[0].Address, subject: .Subject}] | .[0:6]' <<<"$MAIL")"
fi

echo
echo "SMOKE OK (org $ORG_ID, workshop $WS_ID)"
