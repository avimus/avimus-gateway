# Phase 1 Data Model: Gateway WebSocket para Ávimus Patient Journey

All entities are in-memory only (constitution Principle V — zero database
dependency). Nothing here is persisted; every structure is rebuilt empty on
process start.

## HospitalConnection (Tenant Session)

One active WebSocket session from a hospital's integration container.

| Field | Type | Notes |
|---|---|---|
| `tenantId` | `string` | From JWT payload; registry key |
| `erpName` | `string` | From JWT payload |
| `label` | `string` | From JWT payload |
| `jti` | `string` | Token identifier backing this session |
| `socket` | `WebSocket` | The live `ws` connection |
| `connectedAt` | `Date` | Session start |
| `lastActivityAt` | `Date` | Updated on every inbound message |
| `protocolVersion` | `string` | e.g. `"1.0.0"`, checked at handshake |

**Storage**: `Map<tenantId, Set<HospitalConnection>>` — up to 10 entries per
`tenantId` (FR-010; see research.md §2).

**Lifecycle**: created on successful handshake (after `AUTH_OK`) → updated on
each inbound message → removed on disconnect (clean or unclean) or on
`REVOKED` push, whichever comes first. Removal always triggers the
"hospital is offline" notification to Ávimus (FR-006), unless the removal
itself is due to a fresh reconnect of the same session (superseded, not a
real disconnect).

## Credential (Token)

The JWT authentication artifact, validated but not issued by this service.

| Field | Type | Notes |
|---|---|---|
| `jti` | `string` | Unique token identifier |
| `tenantId` | `string` | Owning hospital |
| `erpName` | `string` | Originating system |
| `label` | `string` | Session label |
| `iat` | `number` (epoch seconds) | Issued-at |
| `exp` | `number` (epoch seconds) | `iat` + 90 days |

**Storage**: not stored — verified on the fly from the presented JWT via
`jsonwebtoken.verify` on every connection attempt and on `AUTH_REFRESH`.

## RevocationRecord

| Field | Type | Notes |
|---|---|---|
| `jti` | `string` | Token identifier being revoked |
| `revokedAt` | `Date` | When `/admin/revoke` was called |

**Storage**: `Map<jti, revokedAt>`, checked on every connection attempt and
`AUTH_REFRESH`; growth-bounded in practice by token expiry (a revoked, already
-expired `jti` is harmless to keep, but may be pruned lazily on lookup if it
is past `exp`).

## ForwardedMessage

A heartbeat or clinical event received from a hospital, destined for Ávimus.

| Field | Type | Notes |
|---|---|---|
| `messageId` | `string` | Generated per inbound message, used in ACK/ERROR |
| `type` | `"heartbeat" \| "event"` | Discriminates payload shape |
| `tenantId` | `string` | Originating hospital |
| `payload` | `HeartbeatPayload \| EventPayload` | See contracts/ws-protocol.md |
| `receivedAt` | `Date` | For queue ordering |
| `status` | `"delivered" \| "held" \| "discarded"` | Outcome tracking |

**Storage**: transient — not stored once delivered; only held while queued
(see below).

## PerHospitalMessageQueue

The bounded, in-order, oldest-discarded-first holding area for one hospital's
messages while Ávimus is unreachable.

| Field | Type | Notes |
|---|---|---|
| `tenantId` | `string` | Owning hospital; registry key |
| `messages` | `ForwardedMessage[]` | FIFO order |
| `capacity` | `number` | `MAX_QUEUE_PER_TENANT`, default 100 |

**Storage**: `Map<tenantId, ForwardedMessage[]>`.

**Transition rule** (FR-007/FR-008): on enqueue, if `messages.length >=
capacity`, drop `messages[0]` (oldest) before pushing the new message. On a
successful delivery attempt to Ávimus, drain and deliver `messages` in order,
oldest first, removing each as it's confirmed delivered.

## Relationships

```
HospitalConnection  --(tenantId)-->  PerHospitalMessageQueue
HospitalConnection  --(jti)-->        Credential (validated, not stored)
RevocationRecord    --(jti)-->        Credential (invalidates)
ForwardedMessage    --(tenantId)-->   PerHospitalMessageQueue (when held)
```

No entity is shared across tenants; every registry is keyed by `tenantId`
(except the revocation blacklist, keyed by `jti`, which is inherently
cross-tenant since a `jti` uniquely identifies its owning tenant already).
