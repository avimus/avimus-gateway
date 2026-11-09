# Contrato: túnel conector ↔ gateway ↔ worker (protocolo 1.1)

Decisões de 09/11/2026: **D1**, o túnel leva só saúde e nunca evento clínico (jornada é sempre pelo worker);
**D8**, o worker na nuvem alcança o conector na rede do cliente por este túnel, sem porta aberta no cliente.
Projeto: `avimus-conector-local/PLANO.md`, fases 5 e 6. Exemplos válidos de cada quadro estão em
`tunnel-examples.json`, ao lado deste arquivo; os testes de contrato dos três lados leem esses exemplos.

## Quem fala com quem

```
worker (nuvem) ──HTTP──▶ gateway ──WSS (conexão aberta pelo conector)──▶ conector (rede do cliente) ──▶ banco
               POST /internal/rpc/query        query.request ▶
                                               ◀ query.response | query.error
```

O conector é o `health-socket` (`app/gateway_client.py` + `app/conector/`). Ele abre a conexão e a mantém com
`heartbeat`. Toda consulta é uma consulta **nomeada** do catálogo YAML do conector, com parâmetros validados
lá. O gateway e o worker nunca mandam SQL.

## Handshake (inalterado)

`wss://<gateway>/ws?version=1.1.0`, com `Authorization: Bearer hst_…`. O token é validado na Ávimus
(`/api/v1/internal/validate-token`). O primeiro quadro é `auth_ok`. Os tipos são **sempre em minúsculas**.

## Quadros

| `type` | Sentido | Campos | Observação |
|---|---|---|---|
| `heartbeat` | conector → gateway | `version`, `timestamp` | Resposta `ack`. Único sinal que chega à Ávimus (`/internal/heartbeat`) |
| `auth_refresh` | conector → gateway | `token` | `auth_ok` ou `auth_error` (fecha) |
| `revoked` | gateway → conector | `reason` | O conector para de reconectar |
| `ack` / `error` | gateway → conector | `messageId`, … | `error` com `retryable: false` para quadro inválido |
| `event` | — | — | **Recusado** (`error`, "health only"): D1 |
| `query.request` | gateway → conector | `requestId`, `sistema`, `consulta`, `params`, `timeoutMs` | Ver abaixo |
| `query.response` | conector → gateway | `requestId`, `page`, `last`, `truncado`, `duracaoMs`, `dados` | Uma ou mais páginas |
| `query.error` | conector → gateway | `requestId`, `code`, `status` | Fim do pedido |

### `query.request`
- `requestId`: UUID v4, gerado pelo gateway.
- `sistema` e `consulta`: `^[a-z][a-z0-9_]{0,31}$`.
- `params`: objeto de texto para texto, com no máximo 10 chaves; o conector valida contra o catálogo.
- `timeoutMs`: inteiro entre 1000 e 60000. O conector aplica o próprio prazo (`CONECTOR_TIMEOUT_MS`) e responde
  dentro dele, senão com `query.error` `<sistema>_db_timeout`.

### `query.response`
- `page`: começa em 0 e cresce de 1 em 1. `last: true` só na última página.
- `dados`: lista de objetos coluna → valor, já serializados como na API HTTP do conector (datas
  `YYYY-MM-DD HH:MM:SS[.ffffff]`, hora local do banco).
- `truncado` (só na última página): igual ao da API HTTP; a linha `limite` foi atingida.
- Tamanho: cada quadro tem no máximo **256 KiB**. O conector divide as linhas em páginas para caber. O
  gateway junta as páginas e recusa a resposta inteira acima de **8 MiB** (`<sistema>_resposta_grande_demais`).

### `query.error`
- `code`: `^[a-z][a-z0-9_:]{0,60}$`, o mesmo código que a API HTTP do conector põe em `detail`
  (`shift_consulta_desconhecida`, `parametro_invalido:desde`, `sgu_db_timeout`, `shift_db_ocupado`…).
  Nunca texto livre nem dado do banco.
- `status`: o status HTTP que a API do conector daria (404, 422, 502, 503 ou 504).

## Rota do worker no gateway: `POST /internal/rpc/query`

- Autenticação: `Authorization: Bearer <GATEWAY_RPC_SECRET>`, um segredo próprio do worker, diferente do
  `AVIMUS_INTERNAL_SECRET`.
- Corpo: `{ tenantId, connectorLabel, sistema, consulta, params, timeoutMs }`.
- Resposta **no mesmo formato da API HTTP do conector**, para o `ConnectorAdapter` do worker não mudar:
  - `200 { sistema, consulta, quantidade, truncado, duracao_ms, dados }`
  - erro: `{ detail: <code> }` com o status do `query.error`;
  - `503 { detail: "connector_offline" }` quando não há conector conectado para o `tenantId` + `connectorLabel`;
  - `504 { detail: "connector_timeout" }` quando o prazo estoura no gateway.
- Sem fila: pedido e resposta. Se o conector cair, o worker tenta de novo no próximo ciclo.

## Limites e regras

- No máximo 4 pedidos em andamento por conexão. Acima disso, o gateway responde `503 connector_busy` sem
  enviar o pedido.
- Resposta com `requestId` desconhecido ou que chega depois do prazo é descartada.
- Logs do gateway e do conector levam só `requestId`, `sistema`, `consulta`, código, duração e quantidade.
  Nunca `params` nem `dados`, que trazem dado pessoal.
