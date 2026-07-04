# Guia do avimus-gateway

Este documento explica como o serviço funciona, como rodar/testar/implantar
localmente, e — principalmente — **o que ainda precisa ser feito manualmente**
antes de considerar isso pronto para produção hospitalar.

Documentos relacionados:
- [`GATEWAY_SPEC.md`](../GATEWAY_SPEC.md) — especificação técnica completa do
  protocolo (formatos de mensagem, endpoints, variáveis de ambiente).
- [`specs/001-websocket-gateway/spec.md`](../specs/001-websocket-gateway/spec.md) —
  especificação funcional (o que o sistema deve fazer, do ponto de vista de
  negócio).
- [`specs/001-websocket-gateway/plan.md`](../specs/001-websocket-gateway/plan.md) —
  plano técnico e decisões de arquitetura.
- [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) —
  princípios não-negociáveis do projeto (robustez, simplicidade, LGPD, zero
  banco de dados, graceful shutdown).

---

## 1. Visão Geral

O gateway é o intermediário entre:

- **Containers `apx-health-socket`** (FastAPI/Python, dentro da rede privada
  de cada hospital cliente, lendo o ERP Oracle Tasy) — que falam WebSocket.
- **API Ávimus Patient Journey** (Hono, rodando no Vercel) — que **não**
  suporta conexões WebSocket persistentes (limitação de plataforma
  serverless).

```
apx-health-socket  --wss://gateway/ws?token=JWT-->  avimus-gateway  --HTTP-->  API Ávimus (Vercel)
```

O gateway resolve esse descompasso: mantém a conexão de longa duração com o
hospital e traduz cada mensagem recebida em uma chamada HTTP para a API.

**Não há banco de dados.** Tudo (conexões ativas, fila de mensagens, lista de
tokens revogados) vive em memória do processo e é perdido em um restart —
essa é uma decisão deliberada da constituição do projeto (Princípio V), não
um esquecimento.

---

## 2. Como Funciona (fluxo por dentro do código)

### 2.1 Autenticação (handshake)

Arquivo: `src/ws/handshake.ts`

1. O container conecta em `wss://gateway/ws?token=<jwt>[&version=1.0.0]`.
2. **Antes** de aceitar a conexão (via `verifyClient` do pacote `ws`), o
   gateway:
   - Exige HTTPS/WSS em produção (aceita `X-Forwarded-Proto: https` quando o
     TLS é terminado por um proxy/load balancer na frente do container).
   - Valida o JWT (`src/auth/verifyToken.ts`): assinatura HMAC-SHA256,
     expiração, campos obrigatórios (`tenantId`, `erpName`, `label`, `jti`).
   - Confere se o `jti` não está na lista de revogados
     (`src/auth/revocationList.ts`).
   - Confere se a versão do protocolo (`?version=`) é compatível (`1.x`).
   - Confere se o hospital (`tenantId`) já não atingiu o limite de 10 conexões
     simultâneas (`src/ws/connectionRegistry.ts`).
3. Se qualquer verificação falhar, a conexão é **rejeitada no nível HTTP**
   (401/403/429) — nenhum WebSocket chega a ser aberto para quem não está
   autenticado. Isso é intencional (ver `research.md` do plano).
4. Se tudo passar, a conexão é aceita e o gateway envia
   `{"type":"auth_ok", ...}` como primeira mensagem.

### 2.2 Mensagens da aplicação

Arquivo: `src/ws/messageHandler.ts` + `src/ws/messageSchema.ts`

- `heartbeat` e `event` são validados e encaminhados para a API Ávimus
  (`src/avimus-client/client.ts`), sempre respondendo `ack` ou `error` ao
  hospital.
- **O CPF nunca é mascarado no payload enviado à API Ávimus** — só é mascarado
  quando aparece em log (`src/logging/maskCpf.ts`). Isso é proposital: a API
  precisa do CPF completo para identificar o paciente; a LGPD só exige que ele
  não apareça completo em **logs**.
- `auth_refresh` (`src/ws/authRefresh.ts`) permite renovar o token numa
  conexão já aberta, sem precisar reconectar.

### 2.3 Resiliência quando a API Ávimus está fora do ar

Arquivos: `src/queue/messageQueue.ts` + `src/queue/replay.ts`

- Se o envio para a API falhar, a mensagem é colocada numa fila em memória
  **por hospital** (até `MAX_QUEUE_PER_TENANT`, padrão 100). O hospital ainda
  recebe `ack` — a mensagem não foi perdida, só está retida.
- Se a fila de um hospital já estiver cheia, a mensagem mais antiga é
  descartada para abrir espaço para a nova (perda limitada e documentada, não
  perda silenciosa e ilimitada).
- **Importante — como a fila é esvaziada**: o gateway **não** tem um timer de
  fundo tentando reenviar. A tentativa de esvaziar a fila de um hospital
  acontece "de carona" na próxima mensagem que esse hospital enviar. Ou seja:
  se um hospital ficar em silêncio (sem mandar heartbeat/evento) depois de
  acumular fila, essa fila só será entregue quando ele voltar a mandar algo.
  Isso foi uma escolha deliberada de simplicidade (ver seção 6 abaixo — é uma
  pendência a revisar).

### 2.4 Monitoramento

Arquivo: `src/http/health.ts` + `src/http/metrics.ts`

- `GET /health` — sem autenticação, para healthcheck de infraestrutura
  (Docker, Kubernetes, etc.): status, total de conexões ativas, uptime.
- `GET /metrics` — exige header `x-internal-secret`, retorna detalhe por
  hospital (conexões ativas, tamanho da fila, última atividade).

### 2.5 Revogação de credencial

Arquivo: `src/http/revoke.ts` + `src/ws/revokeBroadcast.ts`

- `POST /admin/revoke` (com `x-internal-secret` e `{"jti": "..."}`) marca o
  token como revogado e, se houver conexão ativa usando esse `jti`, envia
  `{"type":"revoked", ...}` e fecha a conexão imediatamente.
- Toda chamada (autorizada ou negada) a este endpoint e ao `/metrics` é
  registrada em log de auditoria (`src/logging/auditLog.ts`).

### 2.6 Encerramento (graceful shutdown)

Arquivo: `src/shutdown.ts`

- Ao receber `SIGTERM`/`SIGINT` (o que o Docker manda ao parar/reiniciar o
  container), o gateway fecha todas as conexões ativas de forma ordenada
  (frame de close, não um corte abrupto) antes de encerrar o processo, com um
  tempo limite de segurança de 5 segundos.

---

## 3. Estrutura do Projeto

```
src/
├── config/env.ts            # Carrega e valida variáveis de ambiente
├── auth/                     # Validação de JWT + lista de revogação
├── ws/                       # Servidor WebSocket: handshake, registry, mensagens
├── queue/                    # Fila por tenant + lógica de reenvio
├── avimus-client/            # Cliente HTTP para a API Ávimus
├── http/                     # Rotas HTTP: /health, /metrics, /admin/revoke
├── logging/                  # Logger (pino), máscara de CPF, log de auditoria
├── app.ts                    # Monta tudo (composition root), sem iniciar o servidor
├── shutdown.ts               # Graceful shutdown
└── index.ts                  # Ponto de entrada: carrega config, sobe o servidor

tests/
├── contract/                 # Testes de contrato (formato exato de request/response)
├── integration/              # Um teste por user story (US1-US4) + shutdown
├── unit/                     # Lógica pura: JWT, fila, registry
└── helpers/                  # App de teste, cliente WS de teste, stub da API Ávimus

Dockerfile                    # Build multi-stage, usuário não-root, HEALTHCHECK
```

---

## 4. Como Rodar Localmente

```bash
npm install
cp .env.example .env   # preencha os valores antes de usar
```

Como o projeto usa `process.env` diretamente (sem um carregador de `.env`
automático), exporte as variáveis antes de rodar, por exemplo:

```bash
export GATEWAY_JWT_SECRET=dev-secret
export AVIMUS_API_URL=http://localhost:9090
export AVIMUS_INTERNAL_SECRET=dev-internal-secret
npm run build
npm start
```

Em desenvolvimento local (`NODE_ENV` diferente de `production`), conexões
`ws://` (sem TLS) são aceitas — só em produção o `wss://` é obrigatório.

### Rodar os testes

```bash
npm test
```

Isso compila TypeScript (incluindo os testes) e roda tudo com o test runner
nativo do Node (`node --test`) — sem framework de teste adicional (Jest,
Vitest etc.), por escolha de simplicidade.

### Build e execução via Docker

```bash
docker build -t avimus-gateway .
docker run -p 8080:8080 --env-file .env avimus-gateway
```

A imagem roda como usuário não-root e expõe um `HEALTHCHECK` que chama
`GET /health`.

---

## 5. Variáveis de Ambiente

| Variável | Obrigatória | Padrão | O que é |
|---|---|---|---|
| `PORT` | não | `8080` | Porta HTTP/WS |
| `GATEWAY_JWT_SECRET` | **sim** | — | Segredo para validar os tokens dos hospitais |
| `AVIMUS_API_URL` | **sim** | — | URL base da API Ávimus |
| `AVIMUS_INTERNAL_SECRET` | **sim** | — | Segredo para chamadas de saída E para `/metrics`/`/admin/revoke` |
| `LOG_LEVEL` | não | `info` | Nível de log do pino |
| `MAX_QUEUE_PER_TENANT` | não | `100` | Capacidade da fila por hospital |
| `NODE_ENV` | não | — | Definir como `production` ativa a exigência de WSS |

Veja `.env.example` na raiz do projeto.

---

## 6. Pendências Manuais — O Que Você Precisa Fazer

Isto **não** é código faltando — é implementação completa e testada (47/47
testes passando). O que falta é decisão/configuração humana e infraestrutura
que nenhum código pode decidir sozinho:

### 6.1 Segredos de produção
- [ ] Gerar `GATEWAY_JWT_SECRET` e `AVIMUS_INTERNAL_SECRET` **fortes e
      distintos** para produção (nunca reaproveitar valores de teste/dev).
      Guardar em um cofre de segredos (Vault, AWS Secrets Manager, variável de
      ambiente do SnapDeploy criptografada — o que a empresa já usa).

### 6.2 Quem emite o token JWT?
- [ ] O gateway só **valida** tokens — ele não emite. Precisa existir (ou já
      existir em outro serviço) um processo que gera o JWT
      `{tenantId, erpName, label, jti, iat, exp}` assinado com o mesmo
      `GATEWAY_JWT_SECRET`, e entrega esse token para cada container
      `apx-health-socket`. Confirmar onde isso acontece hoje.

### 6.3 TLS / WSS real
- [ ] Decidir onde o TLS é terminado: no próprio gateway (precisaria de
      certificado configurado no código, não implementado) ou num
      load balancer/ingress na frente dele (mais comum, e é o que o código já
      assume — ele confia no header `X-Forwarded-Proto`). **Se for essa
      segunda opção, confirmar que o proxy realmente seta esse header e que
      não é possível falsificá-lo vindo de fora.**

### 6.4 Restringir `/metrics` e `/admin/revoke` à rede interna (FR-019)
- [ ] O código exige o header `x-internal-secret`, mas a exigência de
      "só acessível pela rede interna" (definida na clarificação da spec) é
      responsabilidade da **infraestrutura de deploy** (regra de ingress/load
      balancer/firewall), não do código. Isso ainda não está configurado em
      lugar nenhum — precisa ser feito na configuração do SnapDeploy.

### 6.5 Deploy no SnapDeploy
- [ ] Configurar o serviço no SnapDeploy usando o `Dockerfile` da raiz,
      variáveis de ambiente da seção 5, e a regra de rede da 6.4.
- [ ] Confirmar a porta exposta (8080) e o healthcheck (`/health`) na
      configuração da plataforma.

### 6.6 Monitoramento/alertas de verdade
- [ ] `/health` e `/metrics` só **expõem dados** — não há alerta automático
      configurado. Alguém precisa ligar isso a uma ferramenta real (Grafana,
      Datadog, o que a Ávimus já usa) e decidir os limites que disparam
      alerta (ex.: quantas mensagens na fila é preocupante?).

### 6.7 Testar com o container e a API reais
- [ ] Todos os testes usam um **stub** da API Ávimus e um cliente WebSocket
      genérico — nunca foi testado contra o `apx-health-socket` real nem
      contra a API Ávimus real. Fazer um teste de integração manual com os
      sistemas de verdade antes de ir para produção.

### 6.8 Revisar a limitação da fila (seção 2.3)
- [ ] Decidir se o comportamento "só tenta reenviar a fila quando o hospital
      manda a próxima mensagem" é aceitável, ou se é necessário um retry em
      background (timer periódico). Se decidirem que é necessário, isso é uma
      mudança de código a ser planejada — não está implementada hoje.

### 6.9 CI (integração contínua)
- [ ] Não existe pipeline configurado para rodar `npm test` automaticamente
      em pull requests. Configurar isso (GitHub Actions ou equivalente) antes
      de múltiplas pessoas contribuírem no repositório.

### 6.10 Publicar a branch
- [ ] O trabalho está na branch local `001-websocket-gateway`, ainda não
      enviada (`git push`) nem com Pull Request aberto.

---

## 7. Perguntas Já Respondidas (não precisa decidir de novo)

Estas ficaram registradas na especificação para não serem re-discutidas:

- **Fila cheia**: descarta a mensagem mais antiga (não rejeita a nova).
- **Disponibilidade alvo**: 99.9% mensal.
- **Auditoria**: toda ação administrativa (revogação, acesso negado) é
  logada.
- **CPF em log**: sempre mascarado (`***.456.789-**`); no payload para a API
  Ávimus, sempre completo.
- **Múltiplas conexões por hospital**: até 10 simultâneas são esperadas e
  suportadas (não é um único socket por hospital).
