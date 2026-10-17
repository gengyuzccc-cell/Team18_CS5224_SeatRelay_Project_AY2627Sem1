# access-control — Access control (plan §4, Table 3; C7)

- Verdict: **PASS** (177/177 checks passed)
- Pass criterion (plan §4): 401 without / with a tampered token; 403 on every cross-organisation organiser route and command; OFFER_NOT_YOURS for someone else's offer; 404 for another user's command; nothing changed
- Run id: `d65305fd-55b2-444a-b7e5-b51dfb00651b`, started 2026-10-17T21:16:19.960Z, finished 2026-10-17T21:17:13.734Z (54 s)
- Target: dev (https://3s8s2lavzi.execute-api.ap-southeast-1.amazonaws.com); runs: 3; holdSeconds: 900; fault flags: on
- Commit: d34e0ac632e7b96126b1eb980192ea32ec24b8d9 on claude/serene-lovelace-7t14s9
- Label: post-ux-deploy
- Script: `tools/experiments/src/access-control.ts`; raw samples: `raw.csv`; parameters: `meta.json`

## Result

- Negative probes: **165/165** answered as expected

| group | probes | as expected | expected answers |
|---|---|---|---|
| no token | 51 | 51 | 401, 200 |
| someone else's offer | 6 | 6 | REJECTED(OFFER_NOT_YOURS) |
| cross-org (outsider organiser) | 36 | 36 | 403 FORBIDDEN |
| cross-org (participant) | 36 | 36 | 403 FORBIDDEN |
| cross-org (own org path) | 6 | 6 | 404 NOT_FOUND |
| command visibility | 18 | 18 | 404 NOT_FOUND, 200, 409 CONFLICT |
| unknown / malformed | 12 | 12 | 404 NOT_FOUND, 400 VALIDATION_ERROR |

## Probes

| run | group | probe | who | request | expected | actual | verdict |
|---|---|---|---|---|---|---|---|
| 1 | no token | missing token → 401 | anonymous | GET /me | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /me/registrations | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /me/notifications | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /commands/{id} | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/export.csv | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/verify | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | POST /orgs | 401 | 401 | PASS |
| 1 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | GET /me | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | GET /me/registrations | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | GET /me/notifications | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | GET /commands/{id} | 401 | 401 | PASS |
| 1 | no token | tampered token → 401 | victim (bad signature) | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 1 | no token | public health without a token | anonymous | GET /health | 200 | 200 | PASS |
| 1 | someone else's offer | ACCEPT_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 1 | someone else's offer | DECLINE_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 1 | cross-org (outsider organiser) | dashboard | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | CSV export | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | verify | outsider organiser | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | attendance | outsider organiser | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | list workshops | outsider organiser | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | create workshop | outsider organiser | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | add self as member | outsider organiser | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | edit workshop | outsider organiser | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | SET_CAPACITY | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | CANCEL_SESSION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | CLOSE_REGISTRATION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (outsider organiser) | CANCEL_WORKSHOP | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | dashboard | participant | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | CSV export | participant | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | verify | participant | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | attendance | participant | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | list workshops | participant | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | create workshop | participant | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | add self as member | participant | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | edit workshop | participant | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | SET_CAPACITY | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | CANCEL_SESSION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | CLOSE_REGISTRATION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (participant) | CANCEL_WORKSHOP | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 1 | cross-org (own org path) | dashboard via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | cross-org (own org path) | CSV export via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | command visibility | another participant reads the victim's command | attacker | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | command visibility | an outsider organiser reads the victim's command | outsider organiser | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | command visibility | the issuer reads it | victim | GET /commands/{id} | 200 | 200 | PASS |
| 1 | command visibility | the workshop's organiser reads it | organiser | GET /commands/{id} | 200 | 200 | PASS |
| 1 | command visibility | unknown command | victim | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | command visibility | re-POST of the victim's commandId by another user | attacker | POST /workshops/{id}/commands | 409 CONFLICT | 409 CONFLICT | PASS |
| 1 | unknown / malformed | command on an unknown workshop | attacker | POST /workshops/{id}/commands | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | unknown / malformed | public view of an unknown workshop | attacker | GET /workshops/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 1 | unknown / malformed | malformed command body | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| 1 | unknown / malformed | unknown command type | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /me | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /me/registrations | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /me/notifications | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /commands/{id} | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/export.csv | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/verify | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | POST /orgs | 401 | 401 | PASS |
| 2 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | GET /me | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | GET /me/registrations | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | GET /me/notifications | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | GET /commands/{id} | 401 | 401 | PASS |
| 2 | no token | tampered token → 401 | victim (bad signature) | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 2 | no token | public health without a token | anonymous | GET /health | 200 | 200 | PASS |
| 2 | someone else's offer | ACCEPT_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 2 | someone else's offer | DECLINE_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 2 | cross-org (outsider organiser) | dashboard | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | CSV export | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | verify | outsider organiser | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | attendance | outsider organiser | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | list workshops | outsider organiser | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | create workshop | outsider organiser | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | add self as member | outsider organiser | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | edit workshop | outsider organiser | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | SET_CAPACITY | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | CANCEL_SESSION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | CLOSE_REGISTRATION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (outsider organiser) | CANCEL_WORKSHOP | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | dashboard | participant | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | CSV export | participant | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | verify | participant | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | attendance | participant | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | list workshops | participant | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | create workshop | participant | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | add self as member | participant | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | edit workshop | participant | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | SET_CAPACITY | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | CANCEL_SESSION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | CLOSE_REGISTRATION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (participant) | CANCEL_WORKSHOP | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 2 | cross-org (own org path) | dashboard via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | cross-org (own org path) | CSV export via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | command visibility | another participant reads the victim's command | attacker | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | command visibility | an outsider organiser reads the victim's command | outsider organiser | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | command visibility | the issuer reads it | victim | GET /commands/{id} | 200 | 200 | PASS |
| 2 | command visibility | the workshop's organiser reads it | organiser | GET /commands/{id} | 200 | 200 | PASS |
| 2 | command visibility | unknown command | victim | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | command visibility | re-POST of the victim's commandId by another user | attacker | POST /workshops/{id}/commands | 409 CONFLICT | 409 CONFLICT | PASS |
| 2 | unknown / malformed | command on an unknown workshop | attacker | POST /workshops/{id}/commands | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | unknown / malformed | public view of an unknown workshop | attacker | GET /workshops/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 2 | unknown / malformed | malformed command body | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| 2 | unknown / malformed | unknown command type | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /me | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /me/registrations | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /me/notifications | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /commands/{id} | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/export.csv | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops/{id}/verify | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | POST /orgs | 401 | 401 | PASS |
| 3 | no token | missing token → 401 | anonymous | GET /orgs/{id}/workshops | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | GET /me | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | GET /me/registrations | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | GET /me/notifications | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | POST /workshops/{id}/commands | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | GET /commands/{id} | 401 | 401 | PASS |
| 3 | no token | tampered token → 401 | victim (bad signature) | GET /orgs/{id}/workshops/{id}/dashboard | 401 | 401 | PASS |
| 3 | no token | public health without a token | anonymous | GET /health | 200 | 200 | PASS |
| 3 | someone else's offer | ACCEPT_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 3 | someone else's offer | DECLINE_OFFER of the victim's offer | attacker | POST /workshops/{id}/commands | REJECTED(OFFER_NOT_YOURS) | REJECTED(OFFER_NOT_YOURS) | PASS |
| 3 | cross-org (outsider organiser) | dashboard | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | CSV export | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | verify | outsider organiser | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | attendance | outsider organiser | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | list workshops | outsider organiser | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | create workshop | outsider organiser | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | add self as member | outsider organiser | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | edit workshop | outsider organiser | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | SET_CAPACITY | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | CANCEL_SESSION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | CLOSE_REGISTRATION | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (outsider organiser) | CANCEL_WORKSHOP | outsider organiser | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | dashboard | participant | GET /orgs/{id}/workshops/{id}/dashboard | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | CSV export | participant | GET /orgs/{id}/workshops/{id}/export.csv | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | verify | participant | GET /orgs/{id}/workshops/{id}/verify | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | attendance | participant | PUT /orgs/{id}/workshops/{id}/attendance/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | list workshops | participant | GET /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | create workshop | participant | POST /orgs/{id}/workshops | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | add self as member | participant | POST /orgs/{id}/members | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | edit workshop | participant | PATCH /workshops/{id} | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | SET_CAPACITY | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | CANCEL_SESSION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | CLOSE_REGISTRATION | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (participant) | CANCEL_WORKSHOP | participant | POST /workshops/{id}/commands | 403 FORBIDDEN | 403 FORBIDDEN | PASS |
| 3 | cross-org (own org path) | dashboard via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/dashboard | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | cross-org (own org path) | CSV export via own organisation | outsider organiser | GET /orgs/{id}/workshops/{id}/export.csv | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | command visibility | another participant reads the victim's command | attacker | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | command visibility | an outsider organiser reads the victim's command | outsider organiser | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | command visibility | the issuer reads it | victim | GET /commands/{id} | 200 | 200 | PASS |
| 3 | command visibility | the workshop's organiser reads it | organiser | GET /commands/{id} | 200 | 200 | PASS |
| 3 | command visibility | unknown command | victim | GET /commands/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | command visibility | re-POST of the victim's commandId by another user | attacker | POST /workshops/{id}/commands | 409 CONFLICT | 409 CONFLICT | PASS |
| 3 | unknown / malformed | command on an unknown workshop | attacker | POST /workshops/{id}/commands | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | unknown / malformed | public view of an unknown workshop | attacker | GET /workshops/{id} | 404 NOT_FOUND | 404 NOT_FOUND | PASS |
| 3 | unknown / malformed | malformed command body | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |
| 3 | unknown / malformed | unknown command type | attacker | POST /workshops/{id}/commands | 400 VALIDATION_ERROR | 400 VALIDATION_ERROR | PASS |

## Checks

All 177 checks passed.
