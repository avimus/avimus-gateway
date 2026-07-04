# GATEWAY_SPEC.md — Especificação Técnica do avimus-gateway

**Status**: Referência técnica de implementação
**Relacionado**: [specs/001-websocket-gateway/spec.md](specs/001-websocket-gateway/spec.md) (especificação funcional/negócio)
**Última atualização**: 2026-07-03

---

## 1. Visão Geral

### 1.1 Papel do gateway na arquitetura

O `avimus-gateway` é o serviço intermediário entre os containers `apx-health-socket`
(instalados dentro das redes privadas dos hospitais clientes) e a API principal
Ávimus Patient Journey (Hono, rodando no Vercel). A API Vercel não suporta conexões
WebSocket persistentes (limitação de plataforma serverless), então o gateway:

- Mantém as conexões WSS de longa duração com cada container cliente.
- Traduz mensagens recebidas via WebSocket em chamadas HTTP internas para a API Ávimus.
- Absorve instabilidades temporárias (rede do hospital, API Ávimus fora do ar) sem
  perder eventos clínicos.

### 1.2 Diagrama do fluxo completo

```
┌─────────────────────────────┐
│   Rede privada do hospital   │
│                              │
│  ┌────────────────────────┐  │
│  │  apx-health-socket     │  │        wss://gateway/ws?token=JWT
│  │  (FastAPI/Python)      │──┼──────────────────┐
│  │  lê Oracle Tasy ERP    │  │                  │
│  │  outbox local          │  │                  │
│  └────────────────────────┘  │                  │
└─────────────────────────────┘                  │
                                                   ▼
                                    ┌───────────────────────────┐
                                    │      avimus-gateway        │
                                    │  (Node.js/TypeScript)      │
                                    │                             │
                                    │  - valida JWT               │
                                    │  - blacklist jti (memória)  │
                                    │  - registry de conexões     │
                                    │  - fila por tenant (mem.)    │
                                    └──────────────┬─────────────┘
                                                   │
                                     POST /api/v1/internal/heartbeat
                                     POST /api/v1/internal/events
                                     header: x-internal-secret
                                                   │
                                                   ▼
                                    ┌───────────────────────────┐
                                    │  API Ávimus Patient Journey │
                                    │  (Hono, Vercel)             │
                                    └───────────────────────────┘
```

---

## 2. Autenticação

- Token JWT assinado com `GATEWAY_JWT_SECRET` (HMAC).
- Payload:
  ```json
  {
    "tenantId": "hosp-abc123",
    "erpName": "tasy",
    "label": "unidade-centro",
    "jti": "b3f1c2e0-...",
    "iat": 1735689600,
    "exp": 1743465600
  }
  ```
- Expiração: **90 dias** a partir da emissão (`iat` + 90d = `exp`).
- Revogação: lista negra em memória — `Map<jti, revokedAt: Date>`. Consultada:
  - No momento do handshake (antes de aceitar a conexão).
  - Ao processar `AUTH_REFRESH` em uma conexão já ativa.
  - Assim que `POST /admin/revoke` é chamado, para qualquer conexão ativa com o
    mesmo `jti`.
- Transporte do token: query param no handshake —
  `wss://gateway/ws?token=<jwt>`.

---

## 3. Protocolo de Mensagens (JSON)

Todas as mensagens trafegam como texto JSON sobre o WebSocket, um objeto por frame.

### 3.1 Container → Gateway

**HEARTBEAT**
```json
{ "type": "heartbeat", "version": "1.0.0", "timestamp": "2026-07-03T12:00:00.000Z" }
```

**EVENT**
```json
{
  "type": "event",
  "erpName": "tasy",
  "eventCode": "PATIENT_ADMITTED",
  "cpf": "12345678900",
  "eventDate": "2026-07-03T11:58:00.000Z",
  "metadata": { "bed": "302B", "unit": "UTI" }
}
```

**AUTH_REFRESH**
```json
{ "type": "auth_refresh", "token": "<novo-jwt>" }
```

### 3.2 Gateway → Container

**AUTH_OK** (enviado imediatamente após handshake bem-sucedido, antes de qualquer outra mensagem)
```json
{ "type": "auth_ok", "tenantId": "hosp-abc123", "gatewayVersion": "1.0.0" }
```

**AUTH_ERROR** (conexão é encerrada logo em seguida)
```json
{ "type": "auth_error", "reason": "token expired", "code": 401 }
```
Códigos usados: `401` (token ausente/inválido/expirado), `403` (token revogado ou
versão de protocolo incompatível).

**ACK**
```json
{ "type": "ack", "messageId": "evt-8f3a...", "status": "received" }
```

**ERROR**
```json
{ "type": "error", "messageId": "evt-8f3a...", "reason": "invalid eventCode", "retryable": false }
```

**REVOKED** (enviado quando o `jti` da conexão é revogado enquanto ativa; o container
DEVE parar de enviar dados e alertar operação ao recebê-la — o gateway fecha a
conexão logo em seguida)
```json
{ "type": "revoked", "reason": "credential revoked by operations" }
```

---

## 4. Versionamento de Protocolo

- O handshake (implícito no primeiro `HEARTBEAT` ou em um campo `version` do
  próprio token/query, conforme implementação) informa a versão do protocolo
  falado pelo container, no formato `MAJOR.MINOR.PATCH` (ex.: `1.0.0`).
- O gateway aceita qualquer versão `1.x`. Uma versão com `MAJOR` diferente
  (ex.: `2.0.0` enviado a um gateway que só fala `1.x`) é rejeitada com
  `AUTH_ERROR` (`code: 403`, `reason` explicando a incompatibilidade) antes de
  processar qualquer mensagem de aplicação.

---

## 5. Resiliência

- **Reconexão automática no container**: exponential backoff — 1s, 2s, 4s, 8s,
  ..., até um teto de 60s — com jitter aleatório para evitar reconexões
  sincronizadas de múltiplos containers. Responsabilidade do `apx-health-socket`,
  não do gateway.
- **Gateway fora do ar (do ponto de vista do container)**: o container mantém um
  outbox local (fora do escopo deste serviço) garantindo zero perda de eventos
  até a reconexão.
- **API Ávimus fora do ar (do ponto de vista do gateway)**: o gateway enfileira
  até `MAX_QUEUE_PER_TENANT` (padrão 100) mensagens por tenant, em memória. Ao
  exceder o limite, **descarta a mensagem mais antiga** da fila daquele tenant
  para acomodar a nova. Mensagens são reenviadas em ordem assim que uma
  chamada para a API Ávimus for bem-sucedida novamente.

---

## 6. Endpoints HTTP do Gateway

| Método | Rota            | Autenticação                | Resposta |
|--------|-----------------|------------------------------|----------|
| GET    | `/health`       | nenhuma                      | `{ "status": "ok", "connections": 42, "uptime": 8613 }` |
| GET    | `/metrics`      | header `x-internal-secret`   | conexões ativas e tamanho de fila por tenant |
| POST   | `/admin/revoke` | header `x-internal-secret`   | body `{ "jti": "..." }` → adiciona à blacklist |

`x-internal-secret` é validado contra `AVIMUS_INTERNAL_SECRET` (mesmo segredo
usado nas chamadas de saída para a API Ávimus).

---

## 7. Repasse para a API Ávimus

Todas as chamadas incluem o header `x-internal-secret: <AVIMUS_INTERNAL_SECRET>`.

**Heartbeat**
```
POST {AVIMUS_API_URL}/api/v1/internal/heartbeat
Content-Type: application/json
x-internal-secret: <AVIMUS_INTERNAL_SECRET>

{ "tenantId": "hosp-abc123", "version": "1.0.0", "timestamp": "2026-07-03T12:00:00.000Z" }
```

**Evento**
```
POST {AVIMUS_API_URL}/api/v1/internal/events
Content-Type: application/json
x-internal-secret: <AVIMUS_INTERNAL_SECRET>

{
  "tenantId": "hosp-abc123",
  "erpName": "tasy",
  "eventCode": "PATIENT_ADMITTED",
  "cpf": "12345678900",
  "eventDate": "2026-07-03T11:58:00.000Z",
  "metadata": { "bed": "302B", "unit": "UTI" }
}
```

**Offline** (disparado quando o gateway detecta que uma conexão de tenant caiu)
```
POST {AVIMUS_API_URL}/api/v1/internal/heartbeat
Content-Type: application/json
x-internal-secret: <AVIMUS_INTERNAL_SECRET>

{ "tenantId": "hosp-abc123", "status": "offline" }
```

---

## 8. Variáveis de Ambiente

| Variável                | Obrigatória | Padrão  | Descrição |
|-------------------------|:-----------:|---------|-----------|
| `PORT`                  | não         | `8080`  | Porta HTTP/WS do gateway |
| `GATEWAY_JWT_SECRET`    | sim         | —       | Segredo HMAC para assinar/validar tokens dos containers |
| `AVIMUS_API_URL`        | sim         | —       | Base URL da API Ávimus (Vercel) |
| `AVIMUS_INTERNAL_SECRET`| sim         | —       | Segredo compartilhado: chamadas de saída para a API e autenticação de `/metrics` e `/admin/revoke` |
| `LOG_LEVEL`             | não         | `info`  | Nível de log do pino (`debug`\|`info`\|`warn`\|`error`) |
| `MAX_QUEUE_PER_TENANT`  | não         | `100`   | Capacidade da fila em memória por tenant |

---

## 9. Segurança

- **WSS obrigatório em produção**: conexões `ws://` (não criptografadas) são
  rejeitadas quando `NODE_ENV=production`. Permitidas apenas em desenvolvimento
  local.
- **`x-internal-secret` em todas as chamadas para a API**: nenhuma chamada de
  saída para `AVIMUS_API_URL` é feita sem o header.
- **CPF nunca logado completo**: todo ponto de logging que manipula CPF DEVE
  mascarar o valor antes de emitir o log. Formato de máscara: `***.456.789-**`
  (mantém apenas o bloco intermediário; primeiro bloco e dígitos verificadores
  ficam ocultos). Exemplo de função de máscara:

  ```typescript
  function maskCpf(cpf: string): string {
    const digits = cpf.replace(/\D/g, "");
    if (digits.length !== 11) return "***.***.***-**";
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }
  ```

- **Rate limit**: máximo de 10 conexões simultâneas por `tenantId`. A 11ª
  tentativa é rejeitada (fechamento do handshake) sem afetar as 10 conexões
  existentes.

---

## 10. Docker

- **Dockerfile multi-stage**: estágio `build` instala dependências e compila
  TypeScript → JavaScript; estágio `runtime` copia apenas `dist/` e
  `node_modules` de produção, sem toolchain de build.
- **Usuário não-root**: o processo roda como usuário dedicado (ex.: `node`,
  UID não-privilegiado), nunca como `root`.
- **Healthcheck**: `HEALTHCHECK` do Dockerfile chama `GET /health` e considera
  o container saudável quando `status: "ok"`.

Esboço:

```dockerfile
# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
```

---

## Relação com a Constituição do Projeto

Este documento descreve o protocolo e a implementação; as garantias de mais
alto nível (zero dependência de banco, graceful shutdown, mascaramento de CPF,
simplicidade) são regidas por [.specify/memory/constitution.md](.specify/memory/constitution.md)
e têm precedência em caso de conflito.
