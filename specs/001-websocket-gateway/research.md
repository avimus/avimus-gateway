# Phase 0 Research: Gateway WebSocket para Ávimus Patient Journey

All Technical Context fields were resolved directly from the user-supplied
stack (`Node.js 20 + TypeScript + ws + axios + jsonwebtoken + pino`, Docker
multi-stage for SnapDeploy, zero DB/ORM) and from `GATEWAY_SPEC.md`. No
`NEEDS CLARIFICATION` markers remained, so this phase focuses on best-practice
decisions for each chosen dependency and cross-cutting concern.

## 1. WebSocket auth at handshake (`ws`)

- **Decision**: Validate the JWT during the HTTP upgrade request (before
  `ws` completes the handshake) using the `verifyClient` hook of the `ws`
  `WebSocketServer`, extracting the token from the `?token=` query string.
  Reject with the appropriate HTTP status before upgrade if invalid/expired/
  revoked/incompatible version; only send `AUTH_OK` after the socket is open.
- **Rationale**: Rejecting at the HTTP-upgrade layer avoids ever opening a
  socket for an unauthenticated caller — cheaper, and keeps invalid attempts
  out of the connection registry entirely (constitution Principle I: fail
  predictably, not silently).
- **Alternatives considered**: Accept the upgrade unconditionally and
  authenticate the first WS message — rejected because it briefly holds a
  socket for an unauthenticated caller and complicates the reject path
  (would need `AUTH_ERROR` framing rather than a clean HTTP 401/403).

## 2. Per-tenant connection registry cardinality

- **Decision**: `Map<tenantId, Set<WebSocket>>`, not a single `WebSocket` per
  tenant — up to 10 entries per tenant (FR-010).
- **Rationale**: The spec's rate limit (10 simultaneous connections per
  hospital) and the JWT payload's `erpName`/`label` fields imply multiple
  concurrent sessions per hospital are expected (e.g., separate ERP modules).
  A `Set` keeps eviction, revocation broadcast, and counting simple with
  native collection operations.
- **Alternatives considered**: Single connection per tenant (simplest, but
  contradicts the explicit 10-connection rate limit in the spec).

## 3. Forwarding to the Ávimus API (`axios`)

- **Decision**: A single shared `axios` instance with a fixed timeout (e.g.
  5s) and `x-internal-secret` header pre-configured. A forwarding attempt
  that throws (network error, timeout, or non-2xx) is treated as "Ávimus
  unreachable" for that message — switch the tenant into holding mode
  (FR-007) and enqueue.
- **Rationale**: Matches the spec's Assumption that any failed delivery
  attempt (unreachable or error response) immediately triggers holding mode;
  a single client instance keeps the integration point simple and testable
  (Principle II).
- **Alternatives considered**: A dedicated retry/backoff library — rejected
  as unneeded; the queue-and-flush-on-next-attempt model already gives
  effective retry behavior without extra dependencies.

## 4. JWT validation (`jsonwebtoken`)

- **Decision**: `jwt.verify` with the HMAC secret (`GATEWAY_JWT_SECRET`),
  algorithm pinned explicitly (`HS256`) to prevent algorithm-confusion
  attacks, `exp` enforced by the library. Revocation is a separate in-memory
  check against `Map<jti, revokedAt>` after signature/expiry verification
  passes.
- **Rationale**: Pinning the algorithm is a well-known JWT hardening
  practice; layering the revocation check after cryptographic verification
  keeps the two concerns (authenticity vs. revocation) independently
  testable.
- **Alternatives considered**: Asymmetric signing (RS256) — rejected, no
  requirement for a separate signing/verifying party; the gateway is the
  sole issuer's trust boundary partner here (token issuance is out of scope,
  per spec Assumptions), and the existing `GATEWAY_JWT_SECRET` is already
  symmetric.

## 5. CPF masking (`pino`)

- **Decision**: A single `maskCpf()` helper (shown in `GATEWAY_SPEC.md`
  §9) applied at the point a CPF value is placed into a log call — not a
  generic `pino` redact-path rule, since the CPF also flows through the
  forwarded-message body (not just log metadata).
- **Rationale**: `pino`'s built-in `redact` option only redacts by object
  path in the log payload; using it exclusively would miss CPFs embedded in
  free-text messages. A shared helper enforced at every log call site is
  simpler to reason about and test in isolation (one unit test covers every
  call site).
- **Alternatives considered**: `pino` `redact` paths only — rejected as
  insufficient coverage; a logging middleware that scans all string fields
  for CPF-shaped values — rejected as over-engineered pattern-matching for a
  single well-known field.

## 6. Graceful shutdown

- **Decision**: On `SIGTERM`/`SIGINT`: stop accepting new WS upgrades and new
  HTTP requests, iterate the connection registry closing each socket with a
  clean close frame, then exit once all sockets are closed (or a bounded
  timeout elapses).
- **Rationale**: Directly satisfies constitution Principle VI; a bounded
  timeout prevents a hung socket from blocking deploys indefinitely.
- **Alternatives considered**: Immediate `process.exit()` — rejected, this is
  exactly the abrupt-shutdown behavior the constitution forbids.

## 7. Docker packaging

- **Decision**: Multi-stage Dockerfile (`build` compiles TypeScript, `runtime`
  ships only `dist/` + production `node_modules`), non-root `node` user,
  `HEALTHCHECK` hitting `GET /health`, as already drafted in `GATEWAY_SPEC.md`
  §10.
- **Rationale**: Matches SnapDeploy's expectations and the constitution's
  robustness principle; smaller runtime image, no build toolchain shipped.
- **Alternatives considered**: Single-stage image — rejected, ships
  unnecessary build tooling and increases attack surface.

## Output

All unknowns resolved. Proceeding to Phase 1 (data-model.md, contracts/,
quickstart.md).
