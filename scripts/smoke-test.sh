#!/usr/bin/env bash
#
# smoke-test.sh — gyors curl-alapú füstteszt a Soborbo Tracking Worker-höz.
#
# Mit ellenőriz (a Worker SAJÁT logikáját, külső API-hívás nélkül):
#   1) /api/event/health           -> 200, {"status":"ok"}
#   2) ismeretlen útvonal           -> 404
#   3) hibás JSON body              -> 204 (csendes elutasítás, CLAUDE.md #12)
#   4) hiányzó turnstile_token      -> 204 (érvénytelen payload, csendes)
#   5) teljes érvényes payload      -> 204 (ha a host konfigurált + Turnstile OK)
#                                      403 (ha a Turnstile elutasítja a tokent)
#                                      404 (ha a host nincs a SITE_CONFIG KV-ben)
#
# Amit a curl NEM tud ellenőrizni — ezt kézzel kell (lásd a script végén):
#   - tényleg megérkezik-e az event Meta CAPI / GA4 / Google Ads felé.
#
# Használat:
#   ./scripts/smoke-test.sh <BASE_URL> [TURNSTILE_TOKEN]
#
# Példák:
#   ./scripts/smoke-test.sh http://localhost:8787
#   ./scripts/smoke-test.sh https://event-gateway.<subdomain>.workers.dev
#   ./scripts/smoke-test.sh https://painlessremovals.com <valódi-turnstile-token>
#
# A TURNSTILE_TOKEN opcionális. Production Turnstile secret-tel egy dummy token
# 403-at ad (ez is helyes viselkedés). Igazi 204-es happy path-hez vagy valódi
# böngészőből nyert token kell, vagy a Cloudflare "always passes" teszt secret
# (1x0000000000000000000000000000000AA) a Worker TURNSTILE_SECRET_KEY-ében.

set -uo pipefail

BASE_URL="${1:-}"
TURNSTILE_TOKEN="${2:-dummy-smoke-token}"

if [ -z "$BASE_URL" ]; then
  echo "Használat: $0 <BASE_URL> [TURNSTILE_TOKEN]" >&2
  echo "Példa:     $0 https://event-gateway.<subdomain>.workers.dev" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
NOW="$(date +%s)"
PASS=0
FAIL=0

# check <leírás> <elvárt-kód-regex> <tényleges-kód>
check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" =~ $expected ]]; then
    printf '  \033[32mPASS\033[0m  %-46s [%s]\n' "$desc" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-46s [kapott: %s, várt: %s]\n' "$desc" "$actual" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Soborbo Tracking Worker — füstteszt ==="
echo "Cél: $BASE_URL"
echo

# 1) Health
HEALTH_BODY="$(curl -s "$BASE_URL/api/event/health")"
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/event/health")"
check "health endpoint 200" '^200$' "$HEALTH_CODE"
if [[ "$HEALTH_BODY" == *'"status":"ok"'* ]]; then
  printf '  \033[32mPASS\033[0m  %-46s [%s]\n' "health body status:ok" "$HEALTH_BODY"
  PASS=$((PASS + 1))
else
  printf '  \033[31mFAIL\033[0m  %-46s [%s]\n' "health body status:ok" "$HEALTH_BODY"
  FAIL=$((FAIL + 1))
fi

# 2) Ismeretlen útvonal
UNKNOWN_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/this-route-does-not-exist")"
check "ismeretlen útvonal 404" '^404$' "$UNKNOWN_CODE"

# 3) Hibás JSON
BADJSON_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE_URL/api/event/conversion" \
  -H 'Content-Type: application/json' \
  --data-raw '{ this is not valid json')"
check "hibás JSON body 204 (csendes)" '^204$' "$BADJSON_CODE"

# 4) Hiányzó turnstile_token (érvénytelen payload-struktúra)
NOTOKEN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE_URL/api/event/conversion" \
  -H 'Content-Type: application/json' \
  -d "{\"event_name\":\"contact_form_submit\",\"event_id\":\"smoke-notoken-${NOW}\",\"event_time\":${NOW}}")"
check "hiányzó turnstile_token 204 (csendes)" '^204$' "$NOTOKEN_CODE"

# 5) Teljes érvényes payload
VALID_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE_URL/api/event/conversion" \
  -H 'Content-Type: application/json' \
  -d "{\"event_name\":\"contact_form_submit\",\"event_id\":\"smoke-valid-${NOW}\",\"event_time\":${NOW},\"turnstile_token\":\"${TURNSTILE_TOKEN}\",\"value\":1,\"currency\":\"GBP\",\"source\":\"smoke-test\",\"event_source_url\":\"${BASE_URL}/smoke\",\"user_data\":{\"email\":\"smoke@example.com\"}}")"
check "érvényes payload 204/403/404" '^(204|403|404)$' "$VALID_CODE"
case "$VALID_CODE" in
  204) echo "         -> 204: host konfigurált, Turnstile átengedte, fan-out elindult." ;;
  403) echo "         -> 403: Turnstile elutasította a tokent (dummy token + valódi secret esetén EZ a várt eredmény)." ;;
  404) echo "         -> 404: a host nincs a SITE_CONFIG KV-ben (workers.dev URL-en ez normális, ha nincs hozzá KV kulcs)." ;;
esac

echo
echo "Eredmény: $PASS passed, $FAIL failed."
echo
echo "--- Amit a curl NEM ellenőriz — kézi validáció ($BASE_URL deploy után) ---"
echo "  * Worker logok élőben:   npx wrangler tail"
echo "    -> minden eventnél 'Fan-out completed' sor, platformonként success flag."
echo "  * Meta Events Manager -> Test Events: az event 'Server' forrással megjelenik"
echo "    (amíg a KV configban benne van a test_event_code)."
echo "  * GA4 -> Admin -> DebugView / Realtime: a server-side event látszik."
echo "  * Google Ads -> Goals -> Conversions: 24-48 óra múlva 'Recording' státusz."
echo "  * R2 'soborbo-tracking-dlq' bucket: sikertelen platformhívás ide kerül."

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
