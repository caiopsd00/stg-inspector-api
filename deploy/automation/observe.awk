# The full stream remains in deploy.log/journal. This observer extracts only
# known warnings and error context; it NEVER decides whether a deploy succeeded.
# sanitize_only is also used by the terminal viewer on untrusted log fragments.
function clean(text) {
  gsub(/\033\[[0-?]*[ -\/]*[@-~]/, "", text)
  gsub(/\033\][^\007]*(\007|\033\\)/, "", text)
  gsub(/[[:cntrl:]]/, "", text)
  return text
}
{
  if (sanitize_only) { print clean($0); next }
  print $0
  fflush()
  text = clean($0)
  # Strip BuildKit counters/time so npm ci/prune don't duplicate the same warning.
  sub(/^#[0-9]+[[:space:]]+[0-9.]+[[:space:]]+/, "", text)
  sub(/^\[[0-9TZ:+.-]+\][[:space:]]+/, "", text)
  lower = tolower(text)
  warning = lower ~ /(^|[[:space:]])npm warn([[:space:]]|:)/ \
    || lower ~ /(^|[[:space:]])warning[[:space:]]*:/ \
    || lower ~ /(^|[[:space:]])warn\[[^]]*\]/ \
    || lower ~ /level=warning|"level"[[:space:]]*:[[:space:]]*"warn"/ \
    || lower ~ /^[1-9][0-9]* (low|moderate|high|critical) severity vulnerabilit/ \
    || lower ~ /^[1-9][0-9]* vulnerabilities([[:space:]]|$)/ \
    || lower ~ /^aviso:/ || lower ~ /^curl: \([0-9]+\)/
  if (warning && !seen[lower]++) {
    if (++warnings <= 50) {
      print substr(text, 1, 500) >> (state_dir "/warnings")
      close(state_dir "/warnings")
    } else if (warnings == 51) {
      print "Ha outros avisos no log completo (limite de 50 resumos)." > (state_dir "/warnings-overflow")
      close(state_dir "/warnings-overflow")
    }
  }
  if (lower ~ /(^|[[:space:]])(erro:|error:|fatal:|npm error|failed to|falha na etapa)/) {
    if (++errors <= 100) {
      print substr(text, 1, 500) >> (state_dir "/errors")
      close(state_dir "/errors")
    }
  }
}
