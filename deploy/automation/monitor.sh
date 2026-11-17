#!/bin/bash
# A viewer only: never sources configuration, starts/stops services or signals
# the worker. Stage success is structured state, not a guess from log text.
set -euo pipefail
STATE=/var/lib/brlift-deploy
LIB=/usr/local/lib/brlift-deploy
IDS=(preflight git build-api build-web publicacao https web)
LABELS=('Configuracao e verificacoes iniciais' 'Git: backend e frontend' 'Build: backend' 'Build: frontend' 'Publicacao, banco e migracoes' 'HTTPS e health da API' 'Web: HTML e JavaScript')
TTY=0
COLOR=0
PREVIOUS_LINES=0
ROWS=24
COLS=80
ONCE=0
FRESH=0
AFTER_RUN=
BOUND_RUN=
RUN_DIR=
PLAIN_DONE=
PLAIN_STAGE=
PLAIN_WARNINGS=0
PLAIN_HEADER=0
WAIT_STARTED=$SECONDS

reset_result() {
  RUN_ID='' RESULTADO='' ETAPA='' START_EPOCH=0 DURATION_SECONDS=0 COMPLETED='' CUTOVER=0 ERROR_MESSAGE=''
  API_TARGET='' WEB_TARGET=''
}
read_result() {
  local file=$1 key value
  reset_result
  [[ -r "$file" ]] || return 0
  # Data only. In particular no source/eval of log, state or .env files.
  while IFS='=' read -r key value; do
    case "$key" in
      RUN_ID) RUN_ID=$value ;; RESULTADO) RESULTADO=$value ;; ETAPA) ETAPA=$value ;;
      START_EPOCH) START_EPOCH=$value ;; DURATION_SECONDS) DURATION_SECONDS=$value ;;
      COMPLETED) COMPLETED=$value ;; CUTOVER) CUTOVER=$value ;; ERROR_MESSAGE) ERROR_MESSAGE=$value ;;
      API_ALVO) API_TARGET=$value ;; WEB_ALVO) WEB_TARGET=$value ;;
    esac
  done < "$file"
  [[ "$START_EPOCH" =~ ^[0-9]+$ ]] || START_EPOCH=0
  [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] || DURATION_SECONDS=0
}
read_service() {
  local data key value
  SERVICE_ACTIVE=unknown SERVICE_RESULT=unknown SERVICE_EXIT=unknown SERVICE_ID='' SERVICE_JOB=0
  data=$(systemctl show brlift-deploy.service --property=ActiveState,Result,ExecMainStatus,InvocationID,Job) || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      ActiveState) SERVICE_ACTIVE=$value ;; Result) SERVICE_RESULT=$value ;;
      ExecMainStatus) SERVICE_EXIT=$value ;; InvocationID) SERVICE_ID=$value ;; Job) SERVICE_JOB=$value ;;
    esac
  done <<< "$data"
}
active() { [[ "$SERVICE_ACTIVE" == activating || "$SERVICE_ACTIVE" == active || "$SERVICE_ACTIVE" == deactivating ]]; }
sanitize() { awk -v sanitize_only=1 -f "$LIB/observe.awk"; }
clear_frame() {
  local i
  if (( TTY && PREVIOUS_LINES )); then
    printf '\033[%sA' "$PREVIOUS_LINES"
    for ((i=0; i<PREVIOUS_LINES; i++)); do printf '\r\033[2K\n'; done
    printf '\033[%sA' "$PREVIOUS_LINES"
    PREVIOUS_LINES=0
  fi
}
interrupted() {
  trap - INT TERM HUP
  clear_frame
  printf '\nAcompanhamento encerrado. O deploy continua no systemd.\n'
  printf 'Retomar: brlift-deploy watch | Resultado: brlift-deploy status\n'
  exit 130
}
duration() {
  local elapsed=$DURATION_SECONDS now
  if [[ "$RESULTADO" == executando && "$START_EPOCH" != 0 ]]; then
    now=$(date +%s); elapsed=$((now - START_EPOCH)); (( elapsed >= 0 )) || elapsed=0
  fi
  printf '%dmin%02ds' "$((elapsed / 60))" "$((elapsed % 60))"
}
load_messages() {
  WARNINGS=() ERRORS=()
  if [[ -n "$RUN_DIR" ]]; then
    if [[ -r "$RUN_DIR/warnings" ]]; then mapfile -t WARNINGS < "$RUN_DIR/warnings"; fi
    if [[ -r "$RUN_DIR/errors" ]]; then mapfile -t ERRORS < "$RUN_DIR/errors"; fi
  fi
  WARNING_COUNT=${#WARNINGS[@]}
  [[ ! -f "$RUN_DIR/warnings-overflow" ]] || WARNING_COUNT="$WARNING_COUNT+"
}
stage_line() {
  local i=$1 id=${IDS[$1]}
  if [[ " $COMPLETED " == *" $id "* ]]; then
    printf '[OK]   %s' "${LABELS[$i]}"
  elif [[ "$id" == "$ETAPA" && "$RESULTADO" == erro ]]; then
    printf '[ERRO] %s' "${LABELS[$i]}"
  elif [[ "$id" == "$ETAPA" && "$RESULTADO" == executando ]]; then
    printf '[....] %s' "${LABELS[$i]}"
  else printf '[--]   %s' "${LABELS[$i]}"; fi
}
print_frame_line() {
  local text=$1 tint=
  if (( TTY )); then
    if (( ${#text} >= COLS )); then text="${text:0:$((COLS - 4))}..."; fi
    if (( COLOR )); then
      case "$text" in '[OK]'*|*'CONCLUIDO'*) tint=$'\033[32m' ;; '[ERRO]'*|*'FALHOU'*) tint=$'\033[31m' ;; '[AVISO]'*) tint=$'\033[33m' ;; esac
    fi
    printf '\r\033[2K%s%s\033[0m\n' "$tint" "$text"
  else printf '%s\n' "$text"; fi
}
render_running() {
  local i size new_rows new_cols activity='' current='Aguardando o executor iniciar'
  [[ "$ETAPA" != concluido ]] || current='Concluindo registro e aguardando systemd'
  load_messages
  if (( TTY )); then
    size=$({ stty size < /dev/tty; } 2>/dev/null || printf '24 80')
    read -r new_rows new_cols <<< "$size"
    [[ "$new_cols" =~ ^[0-9]+$ && "$new_cols" -ge 10 ]] || new_cols=80
    [[ "$new_rows" =~ ^[0-9]+$ ]] || new_rows=24
    # Resizing may have rewrapped/scrolled the old frame. Do not erase lines
    # that no longer belong to our redraw rectangle in the resized terminal.
    if (( PREVIOUS_LINES && (new_rows != ROWS || new_cols != COLS) )); then
      printf '\n'; PREVIOUS_LINES=0
    fi
    ROWS=$new_rows COLS=$new_cols
    clear_frame
    print_frame_line "BR LIFT - DEPLOY EM ANDAMENTO - $(duration)"
    PREVIOUS_LINES=1
    for i in "${!IDS[@]}"; do
      if (( ROWS >= 17 )); then print_frame_line "$(stage_line "$i")"; ((PREVIOUS_LINES+=1)); fi
      [[ "$ETAPA" != "${IDS[$i]}" ]] || current=${LABELS[$i]}
    done
    if [[ -n "$RUN_DIR" && -f "$RUN_DIR/log" ]]; then activity=$(tail -n 1 "$RUN_DIR/log" | sanitize); fi
    print_frame_line "Etapa: $current"
    print_frame_line "  ${activity:-Preparando...}"
    print_frame_line "Avisos identificados: $WARNING_COUNT | Log completo preservado"
    if (( ${#WARNINGS[@]} )); then
      print_frame_line "[AVISO] ${WARNINGS[${#WARNINGS[@]} - 1]}"
      ((PREVIOUS_LINES+=1))
    fi
    print_frame_line 'Ctrl+C sai do acompanhamento; o deploy continua.'
    ((PREVIOUS_LINES+=4))
  else
    if (( ! PLAIN_HEADER )); then
      print_frame_line "BR LIFT - DEPLOY EM ANDAMENTO - $(duration)"
      PLAIN_HEADER=1
    fi
    for i in "${!IDS[@]}"; do
      if [[ " $COMPLETED " == *" ${IDS[$i]} "* && " $PLAIN_DONE " != *" ${IDS[$i]} "* ]]; then
        print_frame_line "$(stage_line "$i")"; PLAIN_DONE="$PLAIN_DONE ${IDS[$i]}"
      fi
      if [[ "$ETAPA" == "${IDS[$i]}" && "$PLAIN_STAGE" != "$ETAPA" ]]; then
        print_frame_line "$(stage_line "$i")"; PLAIN_STAGE=$ETAPA
      fi
    done
    if (( ${#WARNINGS[@]} > PLAIN_WARNINGS )); then
      for ((i=PLAIN_WARNINGS; i<${#WARNINGS[@]}; i++)); do print_frame_line "[AVISO] ${WARNINGS[$i]}"; done
      PLAIN_WARNINGS=${#WARNINGS[@]}
    fi
  fi
}
render_final() {
  local i first title='FALHOU'
  [[ "$RESULTADO" != sucesso ]] || title=CONCLUIDO
  load_messages
  clear_frame
  print_frame_line "BR LIFT - DEPLOY $title - $(duration)"
  for i in "${!IDS[@]}"; do print_frame_line "$(stage_line "$i")"; done
  if [[ "$RESULTADO" == sucesso ]]; then
    print_frame_line "Erros: 0 | Avisos identificados: $WARNING_COUNT"
  else
    print_frame_line "Erros: 1 (etapa ${ETAPA:-desconhecida}) | Avisos identificados: $WARNING_COUNT"
    if [[ -n "$ERROR_MESSAGE" ]]; then print_frame_line "[ERRO] $(printf '%s' "$ERROR_MESSAGE" | sanitize)"; fi
    first=$((${#ERRORS[@]} - 3)); (( first >= 0 )) || first=0
    for ((i=first; i<${#ERRORS[@]}; i++)); do print_frame_line "  ${ERRORS[$i]}"; done
    if [[ "$CUTOVER" == 1 ]]; then
      print_frame_line 'A troca de versao comecou; verifique o acesso. Sem rollback automatico do banco.'
    else print_frame_line 'Este deploy nao parou o gateway nem trocou containers.'; fi
  fi
  for ((i=0; i<${#WARNINGS[@]} && i<5; i++)); do print_frame_line "[AVISO] ${WARNINGS[$i]}"; done
  if (( ${#WARNINGS[@]} > 5 )); then print_frame_line 'Outros avisos estao no log completo.'; fi
  if [[ -n "$RUN_DIR" && -f "$RUN_DIR/warnings-overflow" ]]; then print_frame_line 'Limite de resumos atingido; consulte o log completo.'; fi
  if [[ -n "$API_TARGET" ]]; then print_frame_line "Commits: API ${API_TARGET:0:8} | Web ${WEB_TARGET:0:8}"; fi
  if [[ -n "$RUN_DIR" ]]; then print_frame_line "Log completo: $RUN_DIR/log"; else print_frame_line 'Log completo: /var/log/brlift-deploy/deploy.log'; fi
}

main() {
  [[ $EUID -eq 0 ]] || { printf 'Execute como root ou com sudo.\n' >&2; return 1; }
  case "${1:-}" in
    --once) ONCE=1 ;;
    --after-run) FRESH=1; AFTER_RUN=${2:-} ;;
    '') ;;
    *) printf 'Modo de acompanhamento invalido.\n' >&2; return 2 ;;
  esac
  if [[ -t 1 && ${TERM:-dumb} != dumb ]]; then
    TTY=1
    [[ -n ${NO_COLOR+x} ]] || COLOR=1
  fi
  trap interrupted INT TERM HUP
  while (( SECONDS - WAIT_STARTED < 2760 )); do
    if ! read_service; then
      clear_frame; printf 'Nao foi possivel consultar systemd. O deploy nao foi interrompido.\n' >&2; return 1
    fi
    if [[ -n "$BOUND_RUN" ]]; then read_result "$STATE/runs/$BOUND_RUN/result"; else read_result "$STATE/last-result"; fi
    # During systemd startup the last result may still belong to the previous
    # invocation. Never show that stale success as this run's result.
    if [[ -z "$BOUND_RUN" && -n "$SERVICE_ID" && "$RUN_ID" != "$SERVICE_ID" ]] && active; then reset_result; fi
    if [[ "$RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]] && { (( ! FRESH )) || [[ "$RUN_ID" != "$AFTER_RUN" ]]; }; then
      BOUND_RUN=$RUN_ID
      RUN_DIR="$STATE/runs/$RUN_ID"
    else
      reset_result
    fi
    if (( ONCE )) && [[ -z "$RUN_ID" ]]; then
      printf 'Sem resumo no formato novo. Consulte brlift-deploy logs ou inicie um deploy.\n'
      printf 'systemd: %s / %s (codigo %s)\n' "$SERVICE_ACTIVE" "$SERVICE_RESULT" "$SERVICE_EXIT"
      return 0
    fi
    if ! active && [[ "$SERVICE_JOB" == 0 || -z "$SERVICE_JOB" ]]; then
      if [[ "$RESULTADO" == sucesso || "$RESULTADO" == erro ]]; then
        if [[ "$SERVICE_RESULT" != success || "$SERVICE_EXIT" != 0 ]]; then
          RESULTADO=erro
          ERROR_MESSAGE="O systemd terminou com $SERVICE_RESULT (codigo $SERVICE_EXIT)."
        fi
        render_final
        [[ "$RESULTADO" == sucesso ]]; return
      fi
      if [[ "$SERVICE_ACTIVE" == failed || -n "$RUN_ID" || $((SECONDS - WAIT_STARTED)) -ge 10 ]]; then
        RESULTADO=erro
        ERROR_MESSAGE="O executor encerrou sem um resultado final desta execucao ($SERVICE_RESULT; codigo $SERVICE_EXIT). Consulte journalctl -u brlift-deploy.service."
        render_final; return 1
      fi
    fi
    render_running
    (( ! ONCE )) || return 0
    # Fresh runs cannot accidentally show the previous run's success. A viewer
    # exits by itself after final state + systemd completion, never tail -F.
    sleep 1
  done
  clear_frame
  printf 'Tempo de acompanhamento excedido; consulte status/logs. O deploy nao foi cancelado.\n'
  return 1
}

main "$@"
