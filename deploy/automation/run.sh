#!/bin/bash
# Installed outside the checkouts: updating Git never replaces a running script.
set -Eeuo pipefail
umask 077

STATE=/var/lib/brlift-deploy
LOG_DIR=/var/log/brlift-deploy
CONFIG=/etc/brlift-deploy.conf
STAGE=preflight
CUTOVER=0
API_BEFORE=unknown
WEB_BEFORE=unknown
API_TARGET=unknown
WEB_TARGET=unknown
STARTED=$(date -u +%FT%TZ)
START_EPOCH=$(date +%s)
RUN_ID=${INVOCATION_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
RUN_DIR=
COMPLETED=
LOGGER_PID=
ERROR_MESSAGE=

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { ERROR_MESSAGE=$*; log "ERRO: $*" >&2; exit 1; }

write_result() {
  local result=$1
  {
    printf 'RESULTADO=%s\nETAPA=%s\nINICIO=%s\nATUALIZADO=%s\n' "$result" "$STAGE" "$STARTED" "$(date -u +%FT%TZ)"
    printf 'API_ANTES=%s\nAPI_ALVO=%s\nWEB_ANTES=%s\nWEB_ALVO=%s\n' "$API_BEFORE" "$API_TARGET" "$WEB_BEFORE" "$WEB_TARGET"
    printf 'RUN_ID=%s\nSTART_EPOCH=%s\nDURATION_SECONDS=%s\nCOMPLETED=%s\nCUTOVER=%s\nERROR_MESSAGE=%s\n' \
      "$RUN_ID" "$START_EPOCH" "$SECONDS" "$COMPLETED" "$CUTOVER" "$ERROR_MESSAGE"
  } > "$RUN_DIR/result.tmp"
  mv "$RUN_DIR/result.tmp" "$RUN_DIR/result"
  cp "$RUN_DIR/result" "$STATE/last-result.tmp"
  mv "$STATE/last-result.tmp" "$STATE/last-result"
}

advance() {
  COMPLETED="${COMPLETED:+$COMPLETED }$STAGE"
  STAGE=$1
  write_result executando
}

finish() {
  local code=$?
  trap - EXIT
  if (( code == 0 )); then
    log 'SUCESSO: deploy concluido; API, web, migracoes e HTTPS verificados.'
  else
    log "FALHA na etapa $STAGE (codigo $code). Consulte brlift-deploy logs."
    if (( CUTOVER )); then
      log 'A troca de versao ja comecou. O gateway pode estar parado ou a nova versao parcialmente ativa.'
      log 'Nao houve rollback automatico do banco. Corrija a causa e execute brlift-deploy novamente.'
    else
      log 'Nao houve troca de containers nem parada do gateway por este deploy.'
    fi
  fi
  # Flush the complete log and warning observer BEFORE publishing a final result.
  # Closing the viewer never owns or signals these service-side processes.
  exec 1>&8 2>&1
  if ! wait "$LOGGER_PID"; then
    code=1
    ERROR_MESSAGE='Falha ao concluir o registro do log; consulte o journal.'
  fi
  if (( code == 0 )); then write_result sucesso; else write_result erro; fi
  rm -f "$STATE/health.json" "$STATE/web.html"
  exit "$code"
}

dc() {
  docker compose --project-name "$PROJECT" \
    --env-file "$API_REPO/.env.production" -f "$API_REPO/compose.production.yml" "$@"
}

check_repo() {
  local repo=$1 status
  [[ -d "$repo" ]] || die "Repositorio ausente: $repo"
  [[ $(git -C "$repo" rev-parse --show-toplevel) == "$repo" ]] || die "Checkout invalido: $repo"
  [[ $(git -C "$repo" branch --show-current) == "$BRANCH" ]] || die "O repositorio $repo precisa estar na branch $BRANCH."
  status=$(git -C "$repo" status --porcelain --untracked-files=all) || die "Nao foi possivel consultar o Git de $repo."
  [[ -z "$status" ]] || die "Ha alteracoes locais em $repo; nada sera descartado."
}

fetch_target() {
  local repo=$1 before=$2 target
  # Command substitution does not inherit errexit on every Bash version.
  timeout 120 git -C "$repo" fetch --no-tags origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >&2 || die "Nao foi possivel atualizar o Git de $repo."
  target=$(git -C "$repo" rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}") || die "Commit remoto invalido em $repo."
  git -C "$repo" merge-base --is-ancestor "$before" "$target" || die "Historico divergente ou commits apenas locais em $repo; nao farei reset."
  [[ -z $(git -C "$repo" ls-tree --name-only "$target" -- .env.production) ]] || die "O commit remoto de $repo tenta versionar .env.production."
  printf '%s' "$target"
}

main() {
  [[ $EUID -eq 0 && $(uname -s) == Linux ]] || die 'Este executor exige Linux e root.'
  for tool in git docker curl flock timeout sha256sum stat tee awk; do
    command -v "$tool" >/dev/null || die "Dependencia ausente: $tool"
  done
  install -d -m 700 "$STATE" "$LOG_DIR"
  exec 9> "$STATE/deploy.lock"
  flock -n 9 || die 'Outro deploy ja possui a trava.'
  [[ "$RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Identificador de execucao invalido.'
  RUN_DIR="$STATE/runs/$RUN_ID"
  install -d -m 700 "$RUN_DIR"
  : > "$RUN_DIR/warnings"
  : > "$RUN_DIR/errors"
  # Keep metadata/warnings for the five most recent runs, independently of a
  # viewer still finishing an older run. Only this tool's state is removed.
  local _stamp old
  while read -r _stamp old; do
    if [[ "$old" =~ ^[a-zA-Z0-9_-]+$ && "$old" != "$RUN_ID" ]]; then rm -rf -- "$STATE/runs/$old"; fi
  done < <(find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | tail -n +6)
  # Keep five completed/running deployment logs; neither .env nor full Compose
  # configuration is ever echoed into them. Also available via journalctl.
  local i
  rm -f "$LOG_DIR/deploy.log.4"
  for i in 3 2 1; do
    if [[ -f "$LOG_DIR/deploy.log.$i" ]]; then mv "$LOG_DIR/deploy.log.$i" "$LOG_DIR/deploy.log.$((i + 1))"; fi
  done
  if [[ -f "$LOG_DIR/deploy.log" ]]; then mv "$LOG_DIR/deploy.log" "$LOG_DIR/deploy.log.1"; fi
  exec 8>&1
  exec > >(tee -a "$LOG_DIR/deploy.log" "$RUN_DIR/log" | awk -v state_dir="$RUN_DIR" -f /usr/local/lib/brlift-deploy/observe.awk) 2>&1
  LOGGER_PID=$!
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  write_result executando
  log 'Iniciando deploy BR LIFT. Nenhum backup, reset ou limpeza de volumes sera executado.'

  [[ -f "$CONFIG" && ! -L "$CONFIG" ]] || die 'Configuracao de deploy ausente ou simbolica.'
  local mode
  mode=$(stat -c %a "$CONFIG")
  if [[ $(stat -c %u "$CONFIG") != 0 ]] || (( (8#$mode & 0022) != 0 )); then
    die 'A configuracao precisa pertencer a root e nao permitir escrita por terceiros.'
  fi
  # This root-owned configuration contains paths/URL only. NEVER source .env.
  # shellcheck source=/dev/null
  source "$CONFIG"
  : "${API_REPO:?}" "${WEB_REPO:?}" "${BRANCH:?}" "${PROJECT:?}" "${HEALTH_URL:?}"
  [[ "$API_REPO" != "$WEB_REPO" ]] || die 'API e web devem ser repositorios distintos.'
  [[ "$HEALTH_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/health$ ]] || die 'HEALTH_URL precisa ser um endereco HTTPS /health sem credenciais.'
  export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15'
  export COMPOSE_ANSI=never COMPOSE_PARALLEL_LIMIT=1 BUILDKIT_PROGRESS=plain WEB_REPO
  cd "$API_REPO"
  check_repo "$API_REPO"
  check_repo "$WEB_REPO"
  [[ -f .env.production && ! -L .env.production ]] || die '.env.production precisa existir como arquivo normal na API.'
  git check-ignore -q .env.production || die '.env.production precisa estar ignorado no Git.'
  local env_hash postgres_id database_id available
  env_hash=$(sha256sum .env.production)
  available=$(df -Pk . | awk 'NR==2 {print $4}')
  (( available >= 2097152 )) || die 'Reserve pelo menos 2 GiB livres antes do build.'
  docker info >/dev/null
  dc config --quiet 2>/dev/null || die 'Compose/.env.production invalidos; os valores da configuracao foram omitidos do log.'
  postgres_id=$(dc ps -q postgres)
  [[ -n "$postgres_id" ]] || die 'PostgreSQL de producao nao esta em execucao. Este comando atualiza uma instalacao existente.'
  database_id=$(dc exec -T postgres psql -U brlift -d brlift -Atqc 'SELECT database_id FROM app_instance WHERE singleton;')
  [[ "$database_id" =~ ^[a-f0-9-]{36}$ ]] || die 'Nao foi possivel identificar o banco existente.'

  advance git
  API_BEFORE=$(git -C "$API_REPO" rev-parse HEAD)
  WEB_BEFORE=$(git -C "$WEB_REPO" rev-parse HEAD)
  # Validate BOTH histories before fast-forwarding EITHER checkout. Pin the
  # fetched commits so a later push does not change this release mid-build.
  API_TARGET=$(fetch_target "$API_REPO" "$API_BEFORE")
  WEB_TARGET=$(fetch_target "$WEB_REPO" "$WEB_BEFORE")
  log "API: $API_BEFORE -> $API_TARGET"
  log "WEB: $WEB_BEFORE -> $WEB_TARGET"
  write_result executando
  git -C "$API_REPO" -c core.hooksPath=/dev/null merge --ff-only "$API_TARGET"
  git -C "$WEB_REPO" -c core.hooksPath=/dev/null merge --ff-only "$WEB_TARGET"
  [[ $(sha256sum .env.production) == "$env_hash" ]] || die '.env.production mudou durante a atualizacao; publicacao interrompida.'
  dc config --quiet 2>/dev/null || die 'A nova configuracao Compose e invalida; valores omitidos do log.'

  advance build-api
  dc build api
  advance build-web
  dc build web
  [[ $(sha256sum .env.production) == "$env_hash" ]] || die '.env.production mudou durante o build; publicacao interrompida.'
  check_repo "$API_REPO"
  check_repo "$WEB_REPO"
  [[ $(git -C "$API_REPO" rev-parse HEAD) == "$API_TARGET" && $(git -C "$WEB_REPO" rev-parse HEAD) == "$WEB_TARGET" ]] || die 'Os commits locais mudaram durante o build.'

  advance publicacao
  log 'Imagens prontas. Iniciando breve indisponibilidade do acesso publico.'
  CUTOVER=1
  write_result executando
  dc stop gateway
  dc up -d --no-build --wait --wait-timeout 300 postgres api web
  # Verify identity and every expected migration before reopening public access.
  dc exec -T api node --input-type=module -e '
    import fs from "node:fs/promises";
    import {pool} from "./dist/server/db.js";
    try {
      const {rows:[identity]} = await pool.query("SELECT database_id FROM app_instance WHERE singleton");
      if (identity?.database_id !== process.argv[1]) throw Error("Identidade do banco mudou");
      const expected = (await fs.readdir("database")).filter(n => /^\d+.*\.sql$/.test(n));
      const {rows} = await pool.query("SELECT name FROM schema_migrations");
      const applied = new Set(rows.map(r => r.name));
      if (!expected.every(n => applied.has(n))) throw Error("Migracoes pendentes");
      const response = await fetch("http://127.0.0.1:3333/health", {signal: AbortSignal.timeout(10000)});
      const health = await response.json();
      if (!response.ok || health.ok !== true || health.databaseId !== process.argv[1]) throw Error("Health da API invalido");
      console.log("Banco original, migracoes e health interno confirmados.");
    } finally { await pool.end(); }
  ' "$database_id"
  # Recreate so a changed, file-bound Caddyfile cannot retain its old inode.
  dc up -d --no-build --force-recreate --wait --wait-timeout 120 gateway

  advance https
  # No -k: a valid public TLS certificate is required. Curl writes the body to
  # a private local file; Node inside the API validates JSON rather than grep.
  local health_file="$STATE/health.json" attempts
  for attempts in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error --proto '=https' --connect-timeout 5 --max-time 15 "$HEALTH_URL" -o "$health_file"; then
      if dc exec -T api node --input-type=module -e '
        let text=""; for await (const part of process.stdin) text += part;
        const health=JSON.parse(text);
        if(health.ok !== true || health.service !== "brlift-api" || health.databaseId !== process.argv[1]) process.exit(1);
      ' "$database_id" < "$health_file"; then break; fi
    fi
    if (( attempts == 6 )); then die 'HTTPS/health publico nao confirmou a aplicacao esperada.'; fi
    sleep 3
  done

  advance web
  local site_url=${HEALTH_URL%/health} web_file="$STATE/web.html" asset
  curl --fail --silent --show-error --proto '=https' --connect-timeout 5 --max-time 15 "$site_url/" -o "$web_file"
  asset=$(dc exec -T api node --input-type=module -e '
    let text=""; for await (const part of process.stdin) text += part;
    const asset=text.match(/<script\b[^>]*\bsrc=[\x22\x27](\/assets\/[A-Za-z0-9_.-]+\.js)[\x22\x27]/i);
    if(!/<!doctype html>/i.test(text) || !/id=[\x22\x27]root[\x22\x27]/.test(text) || !asset) process.exit(1);
    console.log(asset[1]);
  ' < "$web_file") || die 'O endereco publico nao retornou o HTML esperado do web.'
  [[ "$asset" =~ ^/assets/[a-zA-Z0-9_.-]+\.js$ ]] || die 'Asset principal do web invalido.'
  curl --fail --silent --show-error --proto '=https' --connect-timeout 5 --max-time 15 "$site_url$asset" -o /dev/null
  dc ps
  advance concluido
}

main "$@"
