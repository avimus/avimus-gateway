---

description: "Task list for the avimus-gateway WebSocket feature implementation"
---

# Tasks: Gateway WebSocket para Ávimus Patient Journey

**Input**: Design documents from `/specs/001-websocket-gateway/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The project constitution (Principle III) mandates automated
test coverage for non-trivial logic (parsing, branching, connection/reconnection
flow), and `contracts/ws-protocol.md` + `contracts/http-api.md` each define an
explicit contract-test checklist — both count as an explicit test request.

**Organization**: Tasks are grouped by user story (P1–P4 from spec.md) to enable
independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Paths are relative to the repository root; single-project layout (`src/`, `tests/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Initialize Node.js 20 + TypeScript project: `package.json` (scripts:
      `build`, `dev`, `start`, `test`) and `tsconfig.json` with `strict: true`,
      at repository root
- [ ] T002 [P] Install runtime dependencies (`ws`, `axios`, `jsonwebtoken`,
      `pino`) and dev dependencies (`typescript`, `@types/node`, `@types/ws`,
      `@types/jsonwebtoken`) in `package.json`
- [ ] T003 [P] Create source and test directory skeleton per plan.md:
      `src/config/`, `src/auth/`, `src/ws/`, `src/queue/`,
      `src/avimus-client/`, `src/http/`, `src/logging/`, `tests/contract/`,
      `tests/integration/`, `tests/unit/`

**Checkpoint**: Project scaffolding compiles (`tsc --noEmit`) with no source files yet required.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Implement environment config loader/validator in `src/config/env.ts`
      (reads and validates `PORT` [default 8080], `GATEWAY_JWT_SECRET`,
      `AVIMUS_API_URL`, `AVIMUS_INTERNAL_SECRET`, `LOG_LEVEL` [default `info`],
      `MAX_QUEUE_PER_TENANT` [default 100]; throws on missing required vars)
- [ ] T005 [P] Implement `pino` logger setup in `src/logging/logger.ts` and the
      shared `maskCpf()` helper in `src/logging/maskCpf.ts` (masks all but the
      middle block: `***.456.789-**`, per `GATEWAY_SPEC.md` §9)
- [ ] T006 [P] Implement JWT verification in `src/auth/verifyToken.ts`
      (`jsonwebtoken.verify` pinned to `HS256`, validates `exp`, returns the
      typed payload `{tenantId, erpName, label, jti, iat, exp}` or throws a
      typed error)
- [ ] T007 [P] Implement the in-memory revocation blacklist in
      `src/auth/revocationList.ts` (`Map<jti, revokedAt>` with `revoke(jti)`
      and `isRevoked(jti)`)
- [ ] T008 Implement the HTTP+WS server bootstrap and graceful shutdown
      skeleton in `src/index.ts` (creates the HTTP server and attaches a `ws`
      `WebSocketServer`, listens on `PORT`, registers `SIGTERM`/`SIGINT`
      handlers that stop accepting new connections/requests — full drain
      logic is completed in the Polish phase once the connection registry
      exists)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Hospital streams patient journey events in real time (Priority: P1) 🎯 MVP

**Goal**: Accept authenticated WSS connections from hospital containers,
forward heartbeat/event messages to the Ávimus API, and acknowledge every
message.

**Independent Test**: Connect a client with a valid token, send a heartbeat
and an event message, confirm both are forwarded to a stubbed Ávimus API and
that the client receives an ack for each; confirm invalid/expired/revoked
tokens and incompatible protocol versions are rejected at handshake.

### Tests for User Story 1

- [ ] T009 [P] [US1] Contract test for handshake outcomes (valid token →
      `auth_ok`; expired/invalid/revoked token → `auth_error` with correct
      `code`; incompatible major version → `auth_error` code 403) in
      `tests/contract/ws-handshake.test.ts` per `contracts/ws-protocol.md` §Handshake
- [ ] T010 [P] [US1] Contract test for `heartbeat`/`event` → `ack`, and
      malformed frame → `error` (connection stays open) in
      `tests/contract/ws-messages.test.ts` per `contracts/ws-protocol.md` §Inbound
- [ ] T011 [P] [US1] Contract test for `auth_refresh` (valid new token →
      `auth_ok`, connection stays open; invalid new token → `auth_error`,
      connection closes) in `tests/contract/ws-auth-refresh.test.ts`
- [ ] T012 [P] [US1] Unit test for `verifyToken` edge cases (expired, bad
      signature, wrong algorithm, malformed payload) in
      `tests/unit/verifyToken.test.ts`
- [ ] T013 [P] [US1] Unit test for per-tenant connection limit (10 accepted,
      11th rejected without affecting the other 10) in
      `tests/unit/connectionRegistry.test.ts`
- [ ] T014 [P] [US1] Integration test for the full golden path — connect,
      heartbeat, event, receive acks — covering spec.md User Story 1
      acceptance scenarios in `tests/integration/us1-realtime-streaming.test.ts`

### Implementation for User Story 1

- [ ] T015 [US1] Implement the connection registry
      `Map<tenantId, Set<Connection>>` with add/remove and a 10-per-tenant
      limit check in `src/ws/connectionRegistry.ts` (depends on T003)
- [ ] T016 [US1] Implement protocol version compatibility check (accept any
      `1.x`, reject other majors) in `src/ws/protocolVersion.ts`
- [ ] T017 [US1] Implement the handshake `verifyClient` hook in
      `src/ws/handshake.ts`: extract `?token=`, call `verifyToken` (T006),
      check `revocationList.isRevoked` (T007), check protocol version (T016),
      enforce WSS-only when `NODE_ENV=production` (reject `ws://`
      upgrades) — reject before upgrade with the correct HTTP status on any
      failure (depends on T006, T007, T016)
- [ ] T018 [US1] Implement inbound message schema validation for
      `heartbeat`/`event`/`auth_refresh` in `src/ws/messageSchema.ts`
- [ ] T019 [US1] Implement the Ávimus API client (`POST
      /api/v1/internal/heartbeat`, `POST /api/v1/internal/events`) with the
      `x-internal-secret` header and a fixed timeout in
      `src/avimus-client/client.ts` (depends on T004)
- [ ] T020 [US1] Implement the inbound message handler: validate (T018) →
      forward via avimus-client (T019) → respond `ack`/`error`; when logging
      an `event` payload, log only through `maskCpf()` (T005) while the
      payload forwarded to Ávimus keeps the full, unmasked CPF, in
      `src/ws/messageHandler.ts` (depends on T005, T018, T019)
- [ ] T021 [US1] Implement `auth_refresh` handling on an already-open
      connection (re-run T006/T007 validation, send `auth_ok` or
      `auth_error`+close) in `src/ws/authRefresh.ts` (depends on T006, T007)
- [ ] T022 [US1] Wire connection registry, handshake, message handler, and
      auth-refresh handling into `src/ws/server.ts`, and mount it on the HTTP
      server from `src/index.ts` (depends on T015, T017, T020, T021)

**Checkpoint**: User Story 1 is fully functional and independently testable —
hospitals can connect, stream, and get acknowledged.

---

## Phase 4: User Story 2 - Patient data survives temporary Ávimus outages (Priority: P2)

**Goal**: Hold up to 100 messages per hospital in memory when the Ávimus API
is unreachable, discard oldest on overflow, and replay in order once reachable.

**Independent Test**: Simulate the Ávimus API being unreachable, send several
messages from a connected hospital, confirm each still gets an ack; restore
reachability and confirm all held messages are delivered in original order;
confirm the 101st message during an outage discards the oldest held one.

### Tests for User Story 2

- [ ] T023 [P] [US2] Unit test for the bounded queue's drop-oldest-on-overflow
      policy in `tests/unit/messageQueue.test.ts`
- [ ] T024 [P] [US2] Integration test for outage → hold → restore → in-order
      replay, covering spec.md User Story 2 acceptance scenarios, in
      `tests/integration/us2-outage-resilience.test.ts`

### Implementation for User Story 2

- [ ] T025 [US2] Implement the per-tenant bounded message queue
      (`Map<tenantId, ForwardedMessage[]>`, capacity from `MAX_QUEUE_PER_TENANT`,
      drop-oldest-on-overflow) in `src/queue/messageQueue.ts` (depends on T004)
- [ ] T026 [US2] Integrate the queue into forwarding: on a failed delivery
      attempt (network error, timeout, or non-2xx) from avimus-client, enqueue
      the message and still return `ack` to the hospital, in
      `src/ws/messageHandler.ts` (depends on T019, T020, T025)
- [ ] T027 [US2] Implement queue drain/replay-in-order, triggered on the next
      successful delivery attempt for that tenant, in `src/queue/replay.ts`
      (depends on T019, T025)
- [ ] T028 [US2] Implement the "hospital offline" notification (`POST
      /api/v1/internal/heartbeat` with `status: "offline"`) triggered on
      connection close (clean or unclean), in
      `src/avimus-client/offlineNotifier.ts`, wired into connection-close
      handling in `src/ws/connectionRegistry.ts` (depends on T015, T019)

**Checkpoint**: User Stories 1 AND 2 both work independently — no clinical data
is lost during a transient Ávimus outage.

---

## Phase 5: User Story 3 - Operations team monitors gateway and hospital connection health (Priority: P3)

**Goal**: Expose a public health check and an authenticated per-hospital
metrics view.

**Independent Test**: Call `GET /health` without auth and confirm status/
connections/uptime; call `GET /metrics` with and without the correct secret
header and confirm per-hospital detail is returned only when authorized.

### Tests for User Story 3

- [ ] T029 [P] [US3] Contract test for `GET /health` (no auth required, shape
      matches `contracts/http-api.md`) in `tests/contract/http-health.test.ts`
- [ ] T030 [P] [US3] Contract test for `GET /metrics` (401 without the secret
      header, 200 with per-tenant array with it) in
      `tests/contract/http-metrics.test.ts`
- [ ] T031 [P] [US3] Integration test for the monitoring golden path, covering
      spec.md User Story 3 acceptance scenarios, in
      `tests/integration/us3-monitoring.test.ts`

### Implementation for User Story 3

- [ ] T032 [P] [US3] Implement `GET /health` (status, active connection count
      from the registry, process uptime) in `src/http/health.ts` (depends on T015)
- [ ] T033 [US3] Implement the `x-internal-secret` auth middleware in
      `src/http/internalAuth.ts` (depends on T004)
- [ ] T034 [US3] Implement the audit-log helper for admin actions (timestamp,
      action, affected token id — success or denied) in
      `src/logging/auditLog.ts` (depends on T005)
- [ ] T035 [US3] Implement `GET /metrics` (per-tenant active connections and
      queue size), logging denied attempts via the audit helper, in
      `src/http/metrics.ts` (depends on T015, T025, T033, T034)
- [ ] T036 [US3] Wire `/health` and `/metrics` routes into `src/http/server.ts`
      and mount it on the HTTP server from `src/index.ts` (depends on T032, T035)

**Checkpoint**: User Stories 1–3 are all independently functional.

---

## Phase 6: User Story 4 - Operations team revokes a hospital's credential (Priority: P4)

**Goal**: Revoke a credential by `jti`, immediately disconnect any hospital
using it, and reject future connection attempts with it.

**Independent Test**: Revoke the `jti` of an active connection, confirm it
receives `revoked` and is closed; attempt to reconnect with the same token
and confirm it is rejected; revoke a `jti` with no active connection and
confirm a later connection attempt using it is still rejected.

### Tests for User Story 4

- [ ] T037 [P] [US4] Contract test for `POST /admin/revoke` (401 without the
      secret header and no blacklist change; 200 with it, including the
      unknown/inactive-`jti` and missing-`jti` cases) in
      `tests/contract/http-revoke.test.ts` per `contracts/http-api.md`
- [ ] T038 [P] [US4] Contract test for the `revoked` push + close on an active
      connection whose `jti` is revoked in `tests/contract/ws-revoked.test.ts`
      per `contracts/ws-protocol.md` §Outbound
- [ ] T039 [P] [US4] Integration test for the full revoke golden path,
      covering spec.md User Story 4 acceptance scenarios, in
      `tests/integration/us4-revocation.test.ts`

### Implementation for User Story 4

- [ ] T040 [US4] Implement the revoke-broadcast helper: find all active
      connections in the registry matching a `jti`, send `revoked`, then close
      each, in `src/ws/revokeBroadcast.ts` (depends on T015)
- [ ] T041 [US4] Implement `POST /admin/revoke` (validate `jti` body → 400 if
      missing, call `revocationList.revoke` (T007), call revoke-broadcast
      (T040), audit-log the action (T034)) in `src/http/revoke.ts` (depends on
      T007, T033, T034, T040)
- [ ] T042 [US4] Wire the `/admin/revoke` route into `src/http/server.ts`
      (depends on T041)

**Checkpoint**: All four user stories are independently functional end to end.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that span multiple user stories

- [ ] T043 Complete graceful shutdown: on `SIGTERM`/`SIGINT`, stop accepting
      new connections/requests, iterate the connection registry (T015)
      closing each socket with a clean close frame, then exit once all are
      closed or a bounded timeout elapses, in `src/index.ts` (depends on T008, T015)
- [ ] T044 [P] Integration test for graceful shutdown draining active
      connections in order in `tests/integration/graceful-shutdown.test.ts`
      (depends on T043)
- [ ] T045 [P] Write the multi-stage Dockerfile (build + runtime stages,
      non-root user, `HEALTHCHECK` against `GET /health`) at repository root,
      per `GATEWAY_SPEC.md` §10
- [ ] T046 Run through `quickstart.md`'s golden-path verification steps
      end-to-end against a local build and confirm every step matches

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - start immediately
- **Foundational (Phase 2)**: Depends on Setup - BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational + US1's avimus-client
  (T019) and message handler (T020) — extends rather than duplicates them
- **User Story 3 (Phase 5)**: Depends on Foundational + US1's connection
  registry (T015); reads US2's queue (T025) for metrics detail
- **User Story 4 (Phase 6)**: Depends on Foundational + US1's connection
  registry (T015) + US3's internal-auth middleware (T033) and audit helper (T034)
- **Polish (Phase 7)**: Depends on all four user stories being complete

### Parallel Opportunities

- T002, T003 in parallel after T001
- T005, T006, T007 in parallel after T004 (all depend on config, not on each other)
- All `[P]` test tasks within a story phase can run in parallel with each other
- T032 can run in parallel with T033–T035 (different files) within Phase 5
- T037, T038, T039 in parallel within Phase 6

---

## Parallel Example: User Story 1

```bash
# Tests, launched together:
Task: "Contract test for handshake outcomes in tests/contract/ws-handshake.test.ts"
Task: "Contract test for heartbeat/event/malformed messages in tests/contract/ws-messages.test.ts"
Task: "Contract test for auth_refresh in tests/contract/ws-auth-refresh.test.ts"
Task: "Unit test for verifyToken edge cases in tests/unit/verifyToken.test.ts"
Task: "Unit test for 10-connection-per-tenant limit in tests/unit/connectionRegistry.test.ts"
Task: "Integration test for the full golden path in tests/integration/us1-realtime-streaming.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: connect a real client, stream heartbeats/events, confirm acks
5. Deploy/demo if ready — this alone delivers the gateway's core value

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → validate independently → MVP
3. Add US2 → validate independently → outage-resilient
4. Add US3 → validate independently → operable
5. Add US4 → validate independently → revocation-capable
6. Polish (graceful shutdown, Docker, quickstart validation) → production-ready

---

## Notes

- `[P]` tasks touch different files and have no unmet dependencies
- Each user story is independently completable and testable per its
  "Independent Test" description
- Constitution Principle III requires tests for non-trivial logic before a
  task is considered done — the contract/unit tests above are not optional polish
- Verify each test fails before implementing the corresponding task
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently before continuing
