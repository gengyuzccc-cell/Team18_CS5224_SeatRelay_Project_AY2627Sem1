# SeatRelay — Team 18, NUS CS5224 (AY26/27 Sem 1)

Unified registration, fair waitlist and timed-hold **seat relay** for multi-session workshops.
A SaaS on AWS (HTTP API + Lambda + SQS FIFO + DynamoDB + Cognito + SES + CloudFront) with an
on-premise reference deployment (Docker Compose: Node + PostgreSQL + Keycloak + Mailpit) used for
the cloud vs on-prem cost comparison.

> Work in progress. The full execution plan lives in `docs/plan/execution-plan.md`; engineering
> conventions in `docs/CONVENTIONS.md`. The README will become the Final report's Code Explanation.

## Layout

```
packages/contracts   zod schemas + types shared by web / aws / local
packages/core        pure domain engine (decide / allocate / invariants / PER_SESSION baseline)
packages/service     storage & queue ports, API route table, worker orchestration
services/aws         SAM templates, Lambda handlers, DynamoDB/SQS/SES adapters
services/local       on-prem reference (Fastify + PostgreSQL + Keycloak + Mailpit)
apps/web             React SPA (CloudFront or local nginx)
tools/replay         mechanism comparison simulation (unified vs per-session)
tools/loadtest       k6 scenarios
tools/experiments    Table-3 experiment scripts and analysis
tools/scripts        operational scripts
docs/                architecture, runbook, experiments, cost, user study, interviews, demo
results/             raw experiment outputs (single source of truth for report numbers)
report/              Final report (LaTeX) and slides
```

## Quick start

```bash
corepack enable && pnpm install
pnpm lint && pnpm typecheck && pnpm test
```
