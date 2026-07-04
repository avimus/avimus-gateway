# Quickstart: avimus-gateway

## Prerequisites

- Node.js 20
- Docker (for the production-shaped build)

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `8080` | HTTP/WS listen port |
| `GATEWAY_JWT_SECRET` | yes | — | HMAC secret to verify hospital tokens |
| `AVIMUS_API_URL` | yes | — | Base URL of the Ávimus Patient Journey API |
| `AVIMUS_INTERNAL_SECRET` | yes | — | Shared secret for outbound calls to Ávimus AND inbound `/metrics` + `/admin/revoke` auth |
| `LOG_LEVEL` | no | `info` | `pino` log level |
| `MAX_QUEUE_PER_TENANT` | no | `100` | Per-hospital message queue capacity |

## Local development

```bash
npm install
npm run dev        # ws:// allowed locally (wss:// enforced only in production)
```

## Verifying the golden path

1. Start the gateway locally.
2. `curl http://localhost:8080/health` → `{"status":"ok","connections":0,"uptime":...}`.
3. Connect a WebSocket client to `ws://localhost:8080/ws?token=<valid-jwt>` →
   first frame received should be `{"type":"auth_ok",...}`.
4. Send `{"type":"heartbeat","version":"1.0.0","timestamp":"<ISO>"}` → expect
   `{"type":"ack","messageId":"...","status":"received"}`.
5. Stop the local Ávimus API stub, send another heartbeat → still get `ack`
   (now queued); restart the stub and confirm it receives the queued message.
6. `curl -X POST http://localhost:8080/admin/revoke -H "x-internal-secret: $AVIMUS_INTERNAL_SECRET" -d '{"jti":"<jti-from-token>"}'`
   with the connection from step 3 still open → it should receive
   `{"type":"revoked",...}` and close.

## Production build

```bash
docker build -t avimus-gateway .
docker run -p 8080:8080 --env-file .env avimus-gateway
```

The image runs as a non-root user and exposes a `HEALTHCHECK` against
`GET /health`. In production (`NODE_ENV=production`), only `wss://` connections
are accepted, and `/metrics` + `/admin/revoke` must be placed behind an
internal-only network path by the deployment (ingress/load balancer), per
FR-019 — the application-level secret check is a second layer, not the only one.

## Graceful shutdown

Sending `SIGTERM` (what Docker/SnapDeploy send on stop/redeploy) closes all
active WebSocket connections in an orderly fashion before the process exits.
Messages still queued in memory at that point are not persisted — this is an
accepted trade-off of the zero-database-dependency constraint; the hospital
container's own local outbox is expected to retry after reconnecting to a
new instance.
