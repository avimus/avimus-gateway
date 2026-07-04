# Feature Specification: Gateway WebSocket para Ávimus Patient Journey

**Feature Branch**: `001-websocket-gateway`

**Created**: 2026-07-03

**Status**: Draft

**Input**: User description: "Serviço Node.js/TypeScript que atua como gateway WebSocket entre containers externos (apx-health-socket rodando em redes privadas de clientes hospitalares) e a API Ávimus Patient Journey (Hono no Vercel, sem suporte a WebSocket persistente). Responsabilidades: aceitar conexões WSS autenticadas por JWT; validar e revogar tokens; manter registry de conexões ativas; repassar HEARTBEAT e EVENT para a API Ávimus; detectar desconexão; enfileirar mensagens quando a API estiver offline; responder ACK/ERROR; notificar REVOKED. Endpoints administrativos /health, /metrics, /admin/revoke. Mascaramento de CPF em logs, rate limit por tenant, WSS obrigatório em produção."

## Clarifications

### Session 2026-07-03

- Q: Deve haver trilha de auditoria para ações administrativas sensíveis (revogação de credencial, tentativas negadas de acesso a `/metrics` e `/admin/revoke`)? → A: Sim, cada ação (sucesso ou negada) é registrada como log estruturado (timestamp, ação, identificador do token afetado), sem armazenamento de auditoria separado nem novo dependência externa.
- Q: Qual a meta de disponibilidade (uptime) esperada para o gateway? → A: 99.9% mensal (~43 min de indisponibilidade/mês), padrão single-region, compatível com o outbox local e a reconexão com backoff do container cliente.
- Q: Os endpoints administrativos (`/metrics`, `/admin/revoke`) devem ficar restritos à rede interna/privada além do header de segredo? → A: Sim — acesso restrito à rede interna/privada (não expostos publicamente pelo load balancer/ingress) mais o header `x-internal-secret` como segunda camada de defesa.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hospital streams patient journey events in real time (Priority: P1)

A hospital's ERP integration container (`apx-health-socket`), running inside the
hospital's private network, opens an authenticated connection to the gateway and
continuously sends heartbeat and clinical event messages. The gateway forwards
each message to the Ávimus Patient Journey platform and confirms receipt back to
the hospital's container.

**Why this priority**: This is the entire reason the gateway exists — without
reliable authenticated connection and message forwarding, no patient journey
data reaches Ávimus. Every other capability is secondary to this core flow.

**Independent Test**: Connect a client using a valid token, send a heartbeat
message and a clinical event message, and verify both are forwarded to the
Ávimus platform and that the client receives an acknowledgment for each.

**Acceptance Scenarios**:

1. **Given** a hospital container with a valid, non-revoked, non-expired token,
   **When** it opens a secure WebSocket connection, **Then** the gateway
   confirms successful authentication before any application message is
   exchanged.
2. **Given** an accepted connection, **When** the container sends a heartbeat
   message, **Then** the gateway forwards it to Ávimus and returns an
   acknowledgment to the container.
3. **Given** an accepted connection, **When** the container sends a clinical
   event message, **Then** the gateway forwards it to Ávimus and returns an
   acknowledgment to the container.
4. **Given** a connection attempt using an expired, invalid, or revoked token,
   **When** the connection attempt is made, **Then** the gateway rejects it
   with a clear reason before any application message can be exchanged.
5. **Given** an accepted connection, **When** the container sends a malformed,
   unrecognized, or protocol-incompatible message, **Then** the gateway returns
   an error response (indicating whether retrying is worthwhile) and the
   connection remains open unless the incompatibility is version-level.
6. **Given** an accepted connection nearing token expiration, **When** the
   container proactively presents a fresh token on the same connection,
   **Then** the gateway re-authenticates the connection without requiring a
   reconnect.

---

### User Story 2 - Patient data survives temporary Ávimus outages (Priority: P2)

When the Ávimus Patient Journey platform is temporarily unreachable, the gateway
keeps accepting messages from connected hospitals instead of dropping them,
holding a bounded number of messages per hospital until the platform becomes
reachable again, then delivers them in order.

**Why this priority**: Clinical event data must not be silently lost due to a
transient outage on the receiving end; this protects data integrity for
hospital operations that depend on the journey being complete.

**Independent Test**: Simulate the Ávimus platform being unreachable, send
several messages from a connected hospital, then restore reachability and
verify all held messages are delivered in the order they were sent.

**Acceptance Scenarios**:

1. **Given** the Ávimus platform is unreachable, **When** a connected hospital
   sends a message, **Then** the gateway still acknowledges receipt to the
   hospital and holds the message for later delivery.
2. **Given** messages are held for a hospital, **When** the Ávimus platform
   becomes reachable again, **Then** all held messages are delivered in the
   order they were originally sent.
3. **Given** a hospital already has 100 messages held (the maximum), **When** a
   new message arrives while still unreachable, **Then** the gateway discards
   the oldest held message to make room, holds the new one, and still
   acknowledges receipt to the hospital.

---

### User Story 3 - Operations team monitors gateway and hospital connection health (Priority: P3)

An operations engineer checks the overall health of the gateway and, when
investigating an incident, looks up per-hospital connection details (active
connections, held-message counts, last activity).

**Why this priority**: Necessary for running the service reliably in
production, but the gateway delivers its core value (Stories 1-2) even before
this exists.

**Independent Test**: Call the public health check and confirm it reports
status, active connection count, and uptime; call the authenticated metrics
endpoint and confirm it reports per-hospital detail.

**Acceptance Scenarios**:

1. **Given** the gateway is running, **When** anyone requests the health
   status, **Then** the response includes overall status, number of active
   connections, and uptime, without requiring authentication.
2. **Given** a caller presents the correct internal-operations credential,
   **When** they request the metrics endpoint, **Then** the response includes
   per-hospital connection and queue detail.
3. **Given** a caller does not present the correct internal-operations
   credential, **When** they request the metrics endpoint, **Then** access is
   denied.

---

### User Story 4 - Operations team revokes a hospital's credential (Priority: P4)

An operations engineer revokes a specific credential (identified by its unique
token ID) because it was compromised, decommissioned, or issued in error. Any
hospital container currently connected with that credential is immediately
notified and disconnected; any future connection attempt using that same
credential is rejected.

**Why this priority**: A critical security control, but exercised rarely
compared to the continuous flows in Stories 1-2, and the gateway is safe to
operate without it only being invoked occasionally.

**Independent Test**: Revoke the token ID of an active connection and verify
the hospital container receives a revocation notice and is disconnected; then
attempt to reconnect with the same token and verify it is rejected.

**Acceptance Scenarios**:

1. **Given** a caller presents the correct internal-operations credential,
   **When** they revoke a token ID that has an active connection, **Then** that
   connection is notified of the revocation and closed.
2. **Given** a caller presents the correct internal-operations credential,
   **When** they revoke a token ID that has no active connection, **Then** the
   revocation is still recorded so a future connection attempt is rejected.
3. **Given** a caller does not present the correct internal-operations
   credential, **When** they attempt to revoke a token, **Then** the request is
   denied and nothing is revoked.

---

### Edge Cases

- What happens when a token's expiration time is reached while its connection
  is still open? The gateway MUST close the connection rather than let an
  expired credential keep streaming data.
- What happens when a hospital attempts an 11th simultaneous connection while
  10 are already active for it? The new attempt MUST be rejected without
  affecting the 10 existing connections.
- How does the system handle a hospital container that disconnects (network
  drop, container restart) without a clean close? The gateway MUST detect the
  disconnection and notify Ávimus that the hospital is now offline.
- How does the system behave if Ávimus itself returns an error (not merely
  unreachable) for a forwarded message? This MUST be treated the same as an
  outage for that message (held for retry), so a transient Ávimus-side error
  does not silently drop clinical data.
- What happens when a hospital container speaks an incompatible protocol
  version at handshake time? The gateway MUST reject it with a clear,
  actionable reason rather than accepting and failing later.
- What happens during a gateway restart or redeploy while connections and
  held messages exist? Per the graceful-shutdown principle, active connections
  MUST be closed in an orderly fashion; any messages still held in memory at
  shutdown are not persisted (see Assumptions).
- What happens if a non-secure (`ws://`) connection is attempted in production?
  It MUST be rejected; only `wss://` is accepted outside of local development.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept WebSocket connections only when the caller
  presents a valid, non-expired, non-revoked authentication token as part of
  the connection request.
- **FR-002**: System MUST confirm successful authentication to the caller
  before any application message is exchanged, and MUST reject a connection
  attempt with a clear, specific reason when the token is missing, malformed,
  expired, revoked, or the requested protocol version is incompatible.
- **FR-003**: System MUST recognize at least two inbound application message
  types from a connected hospital — a periodic heartbeat/status message and a
  clinical event message — and forward each to the Ávimus Patient Journey
  platform.
- **FR-004**: System MUST allow an already-connected hospital to present a
  refreshed authentication token on the same connection, without requiring a
  reconnect, and re-validate it the same way as an initial connection attempt.
- **FR-005**: System MUST respond to every inbound application message from a
  hospital with either an acknowledgment or an error indication (including
  whether the error is retryable), so the hospital's container always knows
  the outcome of what it sent.
- **FR-006**: System MUST detect when a hospital's connection ends (clean or
  unclean disconnection) and inform the Ávimus Patient Journey platform that
  the hospital is now offline.
- **FR-007**: System MUST hold (queue) messages for a hospital, up to a
  configurable per-hospital limit (default 100), when the Ávimus Patient
  Journey platform is unreachable or erroring, and deliver them in original
  order once it becomes reachable again.
- **FR-008**: System MUST discard the oldest held message for a hospital when
  a new message arrives and that hospital's hold limit has already been
  reached, so newer clinical data is never rejected outright during a
  sustained outage.
- **FR-009**: System MUST support revoking a specific credential by its unique
  token identifier, such that: (a) any hospital currently connected with that
  credential is notified of the revocation and disconnected, and (b) any future
  connection attempt using that credential is rejected.
- **FR-010**: System MUST limit each hospital (tenant) to a maximum of 10
  simultaneous active connections, rejecting additional connection attempts
  beyond that limit without disrupting existing connections.
- **FR-011**: System MUST expose a public health-status view showing overall
  status, count of active connections, and uptime, without requiring
  authentication.
- **FR-012**: System MUST expose an internal-operations-only view showing
  per-hospital connection and queue detail, accessible only to callers
  presenting a valid internal-operations credential.
- **FR-013**: System MUST allow revoking a credential only to callers
  presenting a valid internal-operations credential.
- **FR-014**: System MUST NOT display a complete CPF (Brazilian national ID) in
  any log output; wherever a CPF would be logged, it MUST be masked so only a
  non-identifying portion remains visible.
- **FR-015**: System MUST reject non-secure (unencrypted) connection attempts
  when running in a production environment; only encrypted (WSS) connections
  are accepted in production.
- **FR-016**: System MUST authenticate its own outbound calls to the Ávimus
  Patient Journey platform using a shared internal credential on every call.
- **FR-017**: System MUST close all active hospital connections in an orderly
  fashion when the service is asked to shut down, rather than dropping them
  abruptly (per the project's graceful-shutdown principle).
- **FR-018**: System MUST record every administrative action — credential
  revocation, and denied access attempts to the metrics or revoke views — as a
  structured log entry including a timestamp, the action taken, and the
  affected token identifier, without persisting a separate audit store.
- **FR-019**: The metrics view and the revoke action MUST only be reachable
  from an internal/private network path (not exposed publicly by the
  deployment's load balancer or ingress), in addition to requiring the
  internal-operations credential — a deployment-level requirement, not solely
  an application-level check.

### Key Entities

- **Hospital Connection (Tenant Session)**: Represents one active WebSocket
  session from a hospital's integration container. Attributes: hospital
  identifier, originating system name, session label, associated credential
  identity, connection start time, last activity time, protocol version.
- **Credential (Token)**: The authentication artifact presented at connection
  time or refresh. Attributes: unique token identifier, owning hospital
  identifier, originating system name, session label, issued time, expiration
  time (90 days), revocation status.
- **Revocation Record**: A record that a given credential has been invalidated.
  Attributes: token identifier, time of revocation.
- **Forwarded Message**: A heartbeat or clinical event message received from a
  hospital and destined for the Ávimus Patient Journey platform. Attributes:
  message type, originating hospital connection, payload, delivery status
  (delivered / held / discarded).
- **Per-Hospital Message Queue**: The bounded, in-order, oldest-discarded-first
  holding area for a single hospital's messages while the Ávimus Patient
  Journey platform is unreachable. Attributes: owning hospital identifier,
  ordered messages, queue capacity (default 100).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A hospital's integration container can establish an authenticated
  connection and begin exchanging messages within 2 seconds of a valid
  connection attempt.
- **SC-002**: 100% of heartbeat and event messages sent while the Ávimus
  platform is reachable receive an acknowledgment within 2 seconds.
- **SC-003**: During an Ávimus platform outage, 100% of clinical event messages
  are delivered once reachability is restored, as long as fewer than 100
  messages accumulate for that hospital during the outage; beyond that, only
  the oldest excess messages are the ones discarded.
- **SC-004**: An operations engineer can determine the health of the gateway
  and the connection status of any specific hospital in under 10 seconds using
  the monitoring views.
- **SC-005**: A revoked credential stops being able to exchange any further
  messages within 1 second of the revocation being issued.
- **SC-006**: An audit of gateway logs shows zero occurrences of a complete CPF
  number, across all log volume produced.
- **SC-007**: The gateway sustains 10 simultaneous connections per hospital
  without rejecting any of the first 10 legitimate connection attempts.
- **SC-008**: The gateway maintains at least 99.9% uptime measured monthly (no
  more than ~43 minutes of unplanned downtime per month).

## Assumptions

- The token presented at connection time is issued by an existing, external
  process (outside this gateway); this feature only validates, refreshes, and
  revokes tokens, it does not issue them.
- The shared internal credential used for the gateway's outbound calls to
  Ávimus is the same credential value accepted on the gateway's own
  internal-operations endpoints (health/metrics detail and revoke), since only
  one such secret was identified for this service.
- The per-hospital message queue is held in memory only, consistent with this
  project's zero-database-dependency principle; queued messages not yet
  delivered at the time of a gateway restart are lost. This is an accepted
  trade-off of running without persistent storage, mitigated by the hospital
  container's own local outbox retrying after reconnect.
- A failed delivery attempt to the Ávimus platform (unreachable or error
  response) immediately switches that hospital into "holding" mode for
  subsequent messages, until a delivery attempt succeeds again.
- Local/non-production environments may use unencrypted WebSocket connections
  for development convenience; only production enforces encrypted connections.
- `GATEWAY_SPEC.md` is being authored as a companion technical reference
  alongside this specification; where the two overlap, this spec captures the
  externally-observable behavior and `GATEWAY_SPEC.md` captures the wire-level
  protocol and implementation detail.
