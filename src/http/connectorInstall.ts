import type { IncomingMessage, ServerResponse } from "node:http";

// GET /conector/instalar: primeiro passo da instalação do conector, sem segredo nenhum no texto.
// O admin mostra `curl -fsSL https://<gateway>/conector/instalar | sudo bash -s -- --sistema ... --gateway wss://...`.
// O script pede só o token hst_, busca com ele a credencial do ghcr que a Ávimus já guarda (mesma rota do
// atualizador), faz o login, baixa a imagem fixada no admin (ou a latest) e chama o instalador de dentro dela.
export const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
# Instalação do conector Ávimus — primeiro passo. Só pede o token do conector (gerado no admin).
set -euo pipefail
falha() { echo "ERRO: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || falha "rode com sudo (copie o comando do admin)"
command -v docker >/dev/null || falha "o Docker não está instalado neste servidor"
command -v curl >/dev/null || falha "o curl não está instalado neste servidor"
GW="__GW__"
IFS= read -r -s -p "Token do conector (hst_..., gerado no admin; não aparece na tela): " HST </dev/tty; echo >/dev/tty
[[ "$HST" =~ ^hst_[A-Za-z0-9_-]{10,200}$ ]] || falha "o token precisa começar com hst_ (copie do admin)"
CODE=$(curl -sS -m 20 -o /tmp/avimus-atualizacao.json -w '%{http_code}' -H "Authorization: Bearer $HST" "$GW/conector/atualizacao?credencial=1" || echo 000)
R=$(cat /tmp/avimus-atualizacao.json 2>/dev/null || true); rm -f /tmp/avimus-atualizacao.json
case "$CODE" in
  200) ;;
  401) falha "token recusado (GW_TOKEN_RECUSADO): gere outro no admin, o anterior é revogado" ;;
  000) falha "não consegui falar com $GW (GW_SEM_REDE): confira a saída HTTPS deste servidor" ;;
  *) falha "o gateway respondeu $CODE (GW_ERRO_$CODE): tente de novo em 1 minuto" ;;
esac
campo() { printf '%s' "$R" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
IMG=$(campo image); VER=$(campo desiredVersion); U=$(campo username); T=$(campo token)
[ -n "$IMG" ] || falha "a Ávimus não informou a imagem do conector (GW_SEM_IMAGEM)"
[ -n "$U" ] && [ -n "$T" ] || falha "a credencial do registro não está cadastrada no admin, aba Conector (SEM_CREDENCIAL_REGISTRO)"
REF="$IMG:${"$"}{VER:-latest}"
printf '%s' "$T" | docker login ghcr.io -u "$U" --password-stdin >/dev/null || falha "o ghcr recusou a credencial salva (REGISTRY_AUTH_FAILED): troque na aba Conector"
unset T R
echo "Baixando $REF..."
docker pull -q "$REF" >/dev/null || falha "não consegui baixar $REF (REGISTRY_PULL_FALHOU)"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
docker run --rm "$REF" cat /app/instalar-conector.sh >"$D/instalar.sh" || falha "a imagem $REF não tem o instalador"
AVIMUS_HST="$HST" bash "$D/instalar.sh" "$@" --imagem "$REF"
`;

export function handleConnectorInstall(req: IncomingMessage, res: ServerResponse): void {
  // O endereço vem do Host que o próprio servidor usou para chegar aqui (o Caddy só repassa o nosso domínio).
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "";
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/i.test(host)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
  res.end(INSTALL_SCRIPT.replace("__GW__", `https://${host}`));
}
