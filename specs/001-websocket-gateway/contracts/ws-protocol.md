# Contract: WebSocket Protocol (`wss://gateway/ws?token=<jwt>`)

Wire-level detail lives in [`GATEWAY_SPEC.md`](../../../GATEWAY_SPEC.md); this
contract states the observable request/response guarantees this feature must
satisfy, for use by contract tests.

## Handshake

**Request**: HTTP Upgrade to `wss://<host>/ws?token=<jwt>[&version=1.0.0]`

**Success**: Upgrade completes; first frame sent by the server is:
```json
{ "type": "auth_ok", "tenantId": "string", "gatewayVersion": "string" }
```

**Failure**: The HTTP Upgrade itself is rejected with the corresponding status
code — no WebSocket is ever opened for an unauthenticated caller (see
research.md §1). The client observes this as an `unexpected-response` (HTTP-level
rejection), not as a JSON frame:
- `400`: WSS required (production) but the request wasn't secure.
- `401`: token missing, malformed, or expired.
- `403`: token revoked, or protocol version incompatible (see below).
- `429`: the tenant already has the maximum number of simultaneous connections.

The `auth_error` message *type* is only ever sent over an **already-open**
connection, as the response to a failed `auth_refresh` (see below) — it is
never sent as part of the initial handshake.

## Inbound messages (client → gateway)

| `type` | Required fields | Gateway response |
|---|---|---|
| `heartbeat` | `version`, `timestamp` | `ack` on successful forward or successful enqueue; `error` if payload malformed |
| `event` | `erpName`, `eventCode`, `cpf`, `eventDate`, `metadata` | `ack` on successful forward or successful enqueue; `error` if payload malformed |
| `auth_refresh` | `token` | `auth_ok` if the new token is valid; `auth_error` (connection closed) if not |

Any `type` not in this table, or a frame that isn't valid JSON, yields:
```json
{ "type": "error", "messageId": null, "reason": "string", "retryable": false }
```
and the connection remains open (this is not an auth failure).

## Outbound messages (gateway → client)

| `type` | Fields | Trigger |
|---|---|---|
| `auth_ok` | `tenantId`, `gatewayVersion` | successful handshake or `auth_refresh` |
| `auth_error` | `reason`, `code` | failed handshake or `auth_refresh`; connection closes after |
| `ack` | `messageId`, `status: "received"` | inbound message accepted (forwarded or queued) |
| `error` | `messageId`, `reason`, `retryable` | inbound message rejected (validation failure) |
| `revoked` | `reason` | this connection's `jti` was revoked via `/admin/revoke`; connection closes after |

## Protocol versioning

- Version format: `MAJOR.MINOR.PATCH` (e.g. `1.0.0`), passed as a `?version=`
  query parameter; defaults to `1.0.0` when omitted.
- Gateway accepts any `1.x`; a different `MAJOR` is rejected at handshake
  (HTTP 403 — see Handshake above).

## Contract test coverage (tests/contract/ws-protocol.*)

1. Valid token → `auth_ok` is the first frame received.
2. Expired/invalid/revoked token → HTTP-level rejection with the correct code.
3. Incompatible major version → HTTP-level rejection with code 403.
4. `heartbeat` and `event` → `ack` with matching `messageId`.
5. Malformed frame → `error` with `retryable`, connection stays open.
6. `auth_refresh` with a valid new token → `auth_ok`, connection stays open.
7. `auth_refresh` with an invalid token → `auth_error`, connection closes.
8. Revoking the active `jti` → `revoked` pushed, then connection closes.
