# Contract: HTTP API

Wire-level detail lives in [`GATEWAY_SPEC.md`](../../../GATEWAY_SPEC.md); this
contract states the observable request/response guarantees this feature must
satisfy, for use by contract tests.

## `GET /health`

**Auth**: none

**Response** `200 OK`:
```json
{ "status": "ok", "connections": 42, "uptime": 8613 }
```
- `connections`: total active connections across all tenants.
- `uptime`: process uptime in seconds.

## `GET /metrics`

**Auth**: header `x-internal-secret: <AVIMUS_INTERNAL_SECRET>`; MUST also only
be reachable from an internal/private network path (FR-019 — enforced at
deployment/ingress level, not by this endpoint's code).

**Response** `200 OK` (auth valid):
```json
{
  "tenants": [
    {
      "tenantId": "string",
      "activeConnections": 3,
      "queuedMessages": 0,
      "lastActivityAt": "ISO-8601"
    }
  ]
}
```

**Response** `401 Unauthorized` (missing/incorrect header): no body detail
beyond a generic reason; the denied attempt is logged per FR-018.

## `POST /admin/revoke`

**Auth**: header `x-internal-secret: <AVIMUS_INTERNAL_SECRET>`; MUST also only
be reachable from an internal/private network path (FR-019).

**Request**:
```json
{ "jti": "string" }
```

**Response** `200 OK`:
```json
{ "revoked": true, "jti": "string" }
```
Side effects: `jti` added to the revocation blacklist; any active connection
with that `jti` receives `revoked` (see contracts/ws-protocol.md) and is
closed; the action is logged per FR-018.

**Response** `401 Unauthorized` (missing/incorrect header): nothing is
revoked; the denied attempt is logged per FR-018.

**Response** `400 Bad Request`: missing/malformed `jti` in the request body.

## Contract test coverage (tests/contract/http-api.*)

1. `GET /health` with no auth → `200`, shape matches schema above.
2. `GET /metrics` without the secret header → `401`, nothing revealed.
3. `GET /metrics` with the correct secret header → `200`, per-tenant array.
4. `POST /admin/revoke` without the secret header → `401`, no blacklist change.
5. `POST /admin/revoke` with the correct header and a known `jti` with an
   active connection → `200`, connection receives `revoked` and closes.
6. `POST /admin/revoke` with the correct header and an unknown/inactive `jti`
   → `200` (still recorded for future rejection).
7. `POST /admin/revoke` with a missing `jti` in the body → `400`.
