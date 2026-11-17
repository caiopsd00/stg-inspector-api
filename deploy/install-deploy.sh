#!/bin/bash
set -euo pipefail
umask 077

SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
API_REPO=$SOURCE
WEB_REPO=$(dirname "$SOURCE")/stg-system-web
BRANCH=main
PROJECT=brlift-production
HEALTH_URL=

usage() {
  printf '%s\n' \
    'Uso: bash deploy/install-deploy.sh --health-url https://admin.seu-dominio.com.br/health' \
    'Opcionais: --api-repo CAMINHO --web-repo CAMINHO --branch main' \
    'Instala/atualiza a ferramenta local. Nao faz deploy nem habilita execucao no boot.'
}
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

main() {
  while (( $# )); do
    case "$1" in
      --health-url|--api-repo|--web-repo|--branch)
        [[ $# -ge 2 && -n "$2" ]] || die "Falta valor para $1"
        case "$1" in
          --health-url) HEALTH_URL=$2 ;;
          --api-repo) API_REPO=$2 ;;
          --web-repo) WEB_REPO=$2 ;;
          --branch) BRANCH=$2 ;;
        esac
        shift 2 ;;
      -h|--help) usage; return ;;
      *) usage >&2; exit 2 ;;
    esac
  done
  [[ $EUID -eq 0 && $(uname -s) == Linux ]] || die 'Instale na VPS Linux, como root ou com sudo.'
  [[ -d /run/systemd/system ]] || die 'O servidor precisa estar inicializado com systemd.'
  for tool in git docker curl flock timeout sha256sum stat tee systemctl realpath; do
    command -v "$tool" >/dev/null || die "Dependencia ausente: $tool"
  done
  [[ "$HEALTH_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/health$ ]] || die 'Informe --health-url com HTTPS, sem credenciais e terminado em /health.'
  git check-ref-format --branch "$BRANCH" >/dev/null || die 'Branch invalida.'
  API_REPO=$(realpath -e "$API_REPO")
  WEB_REPO=$(realpath -e "$WEB_REPO")
  [[ "$API_REPO" != "$WEB_REPO" ]] || die 'API e web precisam ser repositorios distintos.'
  [[ $(git -C "$API_REPO" rev-parse --show-toplevel) == "$API_REPO" ]] || die 'Repositorio da API invalido.'
  [[ $(git -C "$WEB_REPO" rev-parse --show-toplevel) == "$WEB_REPO" ]] || die 'Repositorio web invalido.'
  [[ -f "$API_REPO/.env.production" && ! -L "$API_REPO/.env.production" ]] || die 'Mantenha o .env.production da instalacao existente na pasta da API.'
  local active
  active=$(systemctl show brlift-deploy.service --property=ActiveState --value 2>/dev/null || true)
  case "$active" in active|activating|deactivating) die 'Aguarde o deploy atual terminar antes de reinstalar a ferramenta.' ;; esac

  install -d -m 755 /usr/local/lib/brlift-deploy
  install -d -m 700 /var/lib/brlift-deploy /var/log/brlift-deploy
  install -m 755 "$SOURCE/deploy/automation/brlift-deploy" /usr/local/bin/brlift-deploy
  install -m 755 "$SOURCE/deploy/automation/run.sh" /usr/local/lib/brlift-deploy/run.sh
  install -m 644 "$SOURCE/deploy/automation/brlift-deploy.service" /etc/systemd/system/brlift-deploy.service
  {
    printf '# Gerado pelo instalador. Caminhos e URL apenas; nenhuma senha.\n'
    printf 'API_REPO=%q\nWEB_REPO=%q\nBRANCH=%q\nPROJECT=%q\nHEALTH_URL=%q\n' "$API_REPO" "$WEB_REPO" "$BRANCH" "$PROJECT" "$HEALTH_URL"
  } > /etc/brlift-deploy.conf
  chmod 600 /etc/brlift-deploy.conf "$API_REPO/.env.production"
  systemctl daemon-reload
  printf '%s\n' \
    'Instalado. A aplicacao e seus dados nao foram reiniciados ou alterados.' \
    'Iniciar: brlift-deploy | Andamento: brlift-deploy status | Log: brlift-deploy logs' \
    'Nenhum timer, deploy no boot, backup ou armazenamento externo foi criado.'
}

main "$@"
