<!--
Sync Impact Report
Version change: template (unratified) → 1.0.0
Modified principles: n/a (initial ratification)
Added sections:
  - Core Principles I–VI (Robustez em Produção Hospitalar, Simplicidade,
    Código Limpo/Tipado/Testável, Segurança e LGPD, Zero Dependência de
    Banco de Dados, Graceful Shutdown Obrigatório)
  - Restrições Técnicas
  - Fluxo de Desenvolvimento e Qualidade
  - Governança
Removed sections: none (initial fill of template placeholders)
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ no change needed (Constitution
    Check gate is generic and reads this file dynamically)
  - .specify/templates/spec-template.md ✅ no change needed (no hardcoded
    principle references)
  - .specify/templates/tasks-template.md ✅ no change needed (no hardcoded
    principle references)
  - .specify/templates/checklist-template.md ✅ no change needed
Follow-up TODOs: none
-->

# Avimus Gateway Constitution

## Core Principles

### I. Robustez em Produção Hospitalar
O serviço opera como gateway WebSocket em ambiente hospitalar de produção, onde
falhas têm impacto direto sobre sistemas clínicos. Toda alteração DEVE preservar
a disponibilidade e a integridade das conexões WebSocket ativas. Erros DEVEM ser
tratados explicitamente — nenhuma exceção não capturada pode derrubar o
processo. Diante de falhas de rede ou de upstream, o serviço DEVE degradar de
forma previsível (reconexão, backoff, mensagens de erro claras) em vez de falhar
silenciosamente.
**Rationale**: ambiente hospitalar não tolera indisponibilidade silenciosa nem
comportamento imprevisível sob erro.

### II. Simplicidade — Sem Over-Engineering (YAGNI)
Toda solução DEVE usar a implementação mais simples que resolva a necessidade
real e já verificada, não hipóteses futuras. Novas abstrações, camadas,
padrões de design ou dependências SOMENTE são introduzidas quando o código
atual demonstrar necessidade concreta. Complexidade adicional DEVE ser
justificada explicitamente na revisão de código.
**Rationale**: complexidade não solicitada é a maior fonte de bugs e dívida
técnica em serviços críticos; um gateway simples é mais fácil de operar e
depurar sob incidente.

### III. Código Limpo, Tipado e Testável
Todo código DEVE ser escrito em TypeScript com `strict` habilitado no
`tsconfig`; o uso de `any` implícito é proibido. Funções e módulos DEVEM ser
pequenos, coesos e testáveis de forma isolada. Lógica não trivial (parsing,
branching, fluxo de conexão/reconexão, mascaramento de dados) DEVE ter
cobertura de teste automatizado antes de ser considerada concluída.
**Rationale**: tipagem forte e testes são a rede de segurança que permite
evoluir o gateway sem quebrar produção hospitalar.

### IV. Segurança e Conformidade com a LGPD
CPF e demais dados pessoais sensíveis NUNCA DEVEM aparecer completos em logs,
mensagens de erro, stack traces ou qualquer saída persistida. CPF DEVE ser
mascarado (exibindo no máximo os 3 últimos dígitos) em todo ponto de logging,
antes de a informação sair da camada que a recebeu. Todo novo campo de dado
pessoal introduzido no fluxo DEVE ser avaliado quanto à necessidade de
mascaramento antes de ser logado.
**Rationale**: exigência legal (LGPD) e ética em contexto de saúde; vazamento
de CPF em log é uma violação de dados, não um detalhe de implementação.

### V. Zero Dependência de Banco de Dados
O serviço DEVE operar sem banco de dados (SQL ou NoSQL) como dependência de
runtime. Estado necessário DEVE ser mantido em memória do processo; qualquer
necessidade de persistência DEVE ser resolvida por sistemas externos já
existentes, nunca por uma camada de persistência própria deste serviço.
**Rationale**: manter o gateway stateless reduz drasticamente a superfície de
falha, de operação e de compliance — um lugar a menos onde dados de paciente
podem vazar ou ficar desatualizados.

### VI. Graceful Shutdown Obrigatório
O processo DEVE tratar sinais de encerramento (SIGTERM/SIGINT) fechando as
conexões WebSocket ativas de forma ordenada — drenando mensagens em trânsito
quando aplicável — e só então finalizar. Deploys, restarts e escalonamento
NUNCA DEVEM derrubar conexões abruptamente sem passar pelo fluxo de shutdown.
**Rationale**: em produção hospitalar, um encerramento abrupto pode cortar
comunicação de dispositivos ou monitoramento em uso; o shutdown correto é
parte da robustez do serviço, não um extra.

## Restrições Técnicas

- Stack obrigatória: Node.js + TypeScript, com `strict` habilitado no
  `tsconfig`.
- Nenhuma dependência de banco de dados como requisito de runtime (Princípio
  V).
- Novas dependências de terceiros DEVEM ser justificadas (Princípio II) e não
  podem substituir capacidade já coberta pela stdlib do Node.js.
- Logging DEVE ser estruturado; qualquer log contendo dado pessoal passa por
  mascaramento (Princípio IV) antes de ser emitido.

## Fluxo de Desenvolvimento e Qualidade

- Toda mudança que tocar lógica não trivial DEVE incluir teste automatizado
  antes de ser considerada concluída (Princípio III).
- Revisão de código DEVE verificar aderência aos princípios acima, com atenção
  especial a mascaramento de CPF (Princípio IV) e tratamento de shutdown
  (Princípio VI).
- Complexidade adicional (nova dependência, nova abstração, novo serviço
  auxiliar) DEVE ser justificada por escrito na revisão, citando a necessidade
  concreta que a motiva.

## Governança

Esta constituição prevalece sobre qualquer prática, convenção ou preferência
individual em conflito. Emendas exigem: (1) registro da mudança e da
motivação, (2) atualização de versão conforme a política semântica abaixo, (3)
verificação de que os templates dependentes (plan, spec, tasks, checklist)
permanecem consistentes com os princípios revisados.

Política de versionamento semântico:
- MAJOR: remoção ou redefinição incompatível de um princípio existente.
- MINOR: adição de novo princípio ou expansão material de um princípio
  existente.
- PATCH: esclarecimentos, correções de texto, ajustes não semânticos.

Toda revisão de código e todo plano de implementação DEVEM verificar
conformidade com os princípios acima antes da aprovação. Complexidade não
justificada é motivo de rejeição na revisão.

**Version**: 1.0.0 | **Ratified**: 2026-07-03 | **Last Amended**: 2026-07-03
