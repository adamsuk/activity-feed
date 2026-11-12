#!/usr/bin/env bash
# Mechanics of the gradual (canary) deploy driven by .github/workflows/deploy.yml.
#   begin      record the stable version, upload the new one (no traffic yet)
#   canary     send CANARY_PERCENT% of traffic to the new version
#   guardrail  probe the canary version, fail on a breach (no Cloudflare credential)
#   rollback   put the stable version back at 100%, then fail so the run is red
# Version ids pass between steps in files under $RUNNER_TEMP, never executed as shell, and are
# validated as UUIDs before they reach a wrangler command line.
set -euo pipefail

STATE="${RUNNER_TEMP:?}/gradual-deploy"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

wr() { npx --yes "wrangler@${WRANGLER_VERSION:?}" "$@"; }

valid_uuid() { [[ "$1" =~ $UUID_RE ]]; }

canary_percent() {
  local p="${CANARY_PERCENT:?}"
  [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 99 )) || { echo "CANARY_PERCENT must be an integer 1..99" >&2; exit 1; }
  echo "$p"
}

read_id() {
  local id
  id="$(cat "$STATE/$1")"
  valid_uuid "$id" || { echo "bad $1 version id" >&2; exit 1; }
  echo "$id"
}

begin() {
  mkdir -p "$STATE"
  # Stable = the version holding most traffic in the newest deployment. Empty list means
  # the Worker has no deployment: there is nothing to canary against or roll back to. A Worker that
  # does not exist at all makes this lookup fail (error 10007) and stays fatal: bootstrap it first.
  local deployments stable=""
  deployments="$(wr deployments list --name "${WORKER_NAME:?}" --json)"
  stable="$(jq -r 'if length == 0 then "" else (sort_by(.created_on) | last | .versions | sort_by(-.percentage) | first | .version_id) end' <<<"$deployments")"
  if [[ -n "$stable" ]]; then
    valid_uuid "$stable" || { echo "unexpected stable version id" >&2; exit 1; }
  else
    echo "No earlier deployment: this deploy goes straight to 100% (no canary, no rollback target)."
  fi
  printf '%s' "$stable" >"$STATE/stable"

  local out="$STATE/wrangler-output.ndjson" new
  : >"$out"
  WRANGLER_OUTPUT_FILE_PATH="$out" wr versions upload --name "$WORKER_NAME" --no-bundle bundle/index.js \
    --message "canary ${GITHUB_SHA:-unknown}"
  new="$(jq -rs '[.[] | select(.type == "version-upload")] | last | .version_id // empty' "$out")"
  valid_uuid "$new" || { echo "could not read the uploaded version id" >&2; exit 1; }
  printf '%s' "$new" >"$STATE/new"
  echo "stable_version=$stable" >>"${GITHUB_OUTPUT:?}"
  echo "new_version=$new" >>"$GITHUB_OUTPUT"
}

canary() {
  local p new stable
  p="$(canary_percent)"; new="$(read_id new)"; stable="$(read_id stable)"
  wr versions deploy "${new}@${p}" "${stable}@$((100 - p))" --name "${WORKER_NAME:?}" --yes \
    --message "canary ${p}% ${GITHUB_SHA:-unknown}"
}

guardrail() {
  local new requests interval max_pct allowed failures=0 i code
  new="$(read_id new)"
  # Set by the manual forced-failure run (docs/progressive-release.md) to exercise the rollback live.
  if [[ "${GUARDRAIL_FORCE_FAIL:-false}" == "true" ]]; then
    echo "Guardrail forced to fail (GUARDRAIL_FORCE_FAIL=true): no probes were sent." >&2
    exit 1
  fi
  requests="${GUARDRAIL_REQUESTS:?}"; interval="${GUARDRAIL_INTERVAL_SECONDS:?}"; max_pct="${GUARDRAIL_MAX_ERROR_PERCENT:?}"
  allowed=$(( requests * max_pct / 100 ))
  echo "Guardrail: ${requests} requests, ${interval}s apart, at most ${allowed} may fail (${max_pct}%)."
  sleep 5 # a new deployment can take a couple of seconds to propagate
  for ((i = 1; i <= requests; i++)); do
    # The override header pins this request to the canary version, whatever the split.
    code="$(curl -sS -m 10 -o "$STATE/body" -w '%{http_code}' \
      -H "Cloudflare-Workers-Version-Overrides: ${WORKER_NAME:?}=\"${new}\"" "${WORKER_URL:?}" 2>/dev/null)" || code=000
    if [[ "$code" != 200 ]] || ! jq -e 'type == "object"' "$STATE/body" >/dev/null 2>&1; then
      failures=$((failures + 1))
      echo "probe ${i}: FAIL (HTTP ${code})"
      if (( failures > allowed )); then
        echo "Guardrail breached: ${failures} failures of ${i} probes (limit ${allowed} of ${requests})." >&2
        exit 1
      fi
    else
      echo "probe ${i}: ok"
    fi
    sleep "$interval"
  done
  echo "Guardrail passed: ${failures} failures of ${requests} probes."
}

rollback() {
  local stable
  stable="$(read_id stable)"
  wr versions deploy "${stable}@100" --name "${WORKER_NAME:?}" --yes --message "automatic rollback ${GITHUB_SHA:-unknown}"
  echo "Rolled back to ${stable} at 100%. Failing the run so the breach is visible." >&2
  exit 1
}

case "${1:-}" in
  begin|canary|guardrail|rollback) "$1" ;;
  *) echo "usage: $0 begin|canary|guardrail|rollback" >&2; exit 2 ;;
esac
