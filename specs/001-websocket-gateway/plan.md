# Implementation Plan: Gateway WebSocket para Ávimus Patient Journey

**Branch**: `001-websocket-gateway` | **Date**: 2026-07-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-websocket-gateway/spec.md`

## Summary

Build a Node.js/TypeScript WebSocket gateway that sits between hospital-side
`apx-health-socket` containers and the Ávimus Patient Journey API (Hono on
Vercel, which cannot hold persistent WebSocket connections). The gateway
authenticates hospital connections via JWT, forwards heartbeat/event messages
to the Ávimus API over HTTP, holds messages per-hospital (in memory, oldest
discarded on overflow) when that API is unreachable, supports credential
revocation with immediate notification, and exposes health/metrics/revoke
endpoints. Everything runs from a single stateless process with no database —
all registries (connections, queues, revocation list) live in memory and are
rebuilt on restart, backed by the client container's own local outbox.

## Technical Context

**Language/Version**: Node.js 20, TypeScript 5.x (`strict` enabled)

**Primary Dependencies**: `ws` (WebSocket server), `axios` (HTTP calls to the
Ávimus API), `jsonwebtoken` (JWT sign/verify), `pino` (structured logging)

**Storage**: N/A — no database or ORM; all state (connection registry,
per-tenant message queues, revocation blacklist) is process memory only, per
constitution Principle V

**Testing**: Node's built-in test runner (`node --test`) with `node:assert` —
no additional test framework dependency; real `ws` client/server pairs and
Node's global `fetch` for HTTP-level integration tests

**Target Platform**: Linux container (Docker), deployed via SnapDeploy

**Project Type**: Single project — backend WebSocket + HTTP service, no
frontend

**Performance Goals**: Auth + first message exchange within 2s (SC-001);
100% of ACKs delivered within 2s while Ávimus is reachable (SC-002); revoked
credential stops accepting messages within 1s (SC-005)

**Constraints**: Zero database dependency (constitution Principle V); graceful
shutdown draining active connections on SIGTERM/SIGINT (Principle VI); CPF
never logged unmasked (Principle IV); 99.9% monthly uptime target (SC-008);
max 10 simultaneous connections per tenant (FR-010); per-tenant queue capped
at 100 messages, oldest discarded on overflow (FR-007/FR-008); `/metrics` and
`/admin/revoke` reachable only from an internal/private network path in
addition to the secret header (FR-019, a deployment-level constraint)

**Scale/Scope**: No fixed system-wide tenant count was set (deferred during
clarification as low-impact for v1); in-memory `Map`-based registries are
adequate for the realistic scale of a single-hospital-network SaaS deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Robustez em Produção Hospitalar | Explicit error handling on every WS message handler; reconnect/backoff is the client's responsibility, gateway degrades to queuing rather than dropping data | PASS |
| II. Simplicidade — Sem Over-Engineering | Single process, no queue broker, no test framework beyond Node's built-in runner, no DB/ORM; `Map`-based in-memory structures instead of external state stores | PASS |
| III. Código Limpo, Tipado e Testável | TypeScript `strict`; JWT validation, CPF masking, and queue overflow logic are isolated, pure-enough functions with unit tests | PASS |
| IV. Segurança e Conformidade com a LGPD | CPF masking applied at the logging boundary (single shared function, FR-014); admin actions logged per FR-018 | PASS |
| V. Zero Dependência de Banco de Dados | No DB/ORM in dependency list; all registries in memory | PASS |
| VI. Graceful Shutdown Obrigatório | SIGTERM/SIGINT handler closes active WS connections in order before process exit; documented in quickstart | PASS |

No violations — Complexity Tracking table is not needed for this feature.

## Project Structure

### Documentation (this feature)

```text
specs/001-websocket-gateway/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── ws-protocol.md
│   └── http-api.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── config/            # env var loading + validation (PORT, secrets, MAX_QUEUE_PER_TENANT, ...)
├── auth/               # JWT verify/sign, revocation blacklist (Map<jti, revokedAt>)
├── ws/                 # WebSocket server, connection registry (Map<tenantId, Set<Connection>>), message handlers
├── queue/              # per-tenant bounded message queue (drop-oldest on overflow) + replay on reconnect
├── avimus-client/      # axios client for POST /internal/heartbeat, /internal/events, offline notification
├── http/               # GET /health, GET /metrics, POST /admin/revoke route handlers
├── logging/            # pino setup + CPF masking helper
└── index.ts            # composition root, HTTP+WS server bootstrap, graceful shutdown

tests/
├── contract/           # /health, /metrics, /admin/revoke request/response contract tests
├── integration/        # end-to-end: connect → auth → forward → ack; outage → queue → replay; revoke → disconnect
└── unit/                # JWT validation, CPF masking, queue overflow policy, rate limiting

Dockerfile               # multi-stage build (build + runtime), non-root user, HEALTHCHECK on /health
```

**Structure Decision**: Single project (Option 1). This is a standalone
backend service with no UI; source is organized by responsibility
(auth, ws, queue, avimus-client, http, logging) rather than by layer, since
each module maps directly to one functional requirement group in the spec.

## Complexity Tracking

*No entries — Constitution Check has no unresolved violations.*
