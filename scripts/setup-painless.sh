#!/usr/bin/env bash
#
# setup-painless.sh — interaktív (vagy env-based) setup script a Painless
# Soborbo Tracking Worker-konfigurációhoz.
#
# Mit csinál:
#   1) Lekér minden szükséges Painless adatot (Pixel ID, Meta CAPI token,
#      GA4 measurement_id + secret, GAds customer_id + 3 OFFLINE conversion
#      action, Turnstile secret, OAuth client + secret, GAds developer token).
#   2) Felépíti a SITE_CONFIG JSON-t és feltölti KV-be.
#   3) Wrangler secret-eket állít be (TURNSTILE_SECRET_KEY,
#      GADS_OAUTH_CLIENT_ID, GADS_OAUTH_CLIENT_SECRET, GADS_DEVELOPER_TOKEN).
#   4) Validál: kiolvassa a KV értéket és listázza a secret-eket.
#
# Használat:
#   chmod +x scripts/setup-painless.sh
#   ./scripts/setup-painless.sh                    # interaktív
#   ./scripts/setup-painless.sh --production       # test_event_code KIVÉVE
#   ./scripts/setup-painless.sh --dry-run          # csak nyomtat, nem hív wrangler-t
#   ./scripts/setup-painless.sh --only=kv          # csak KV config, secret-ek nélkül
#   ./scripts/setup-painless.sh --only=secrets     # csak secret-ek
#
# Env override (CI-ben hasznos):
#   PIXEL_ID, META_ACCESS_TOKEN, GA4_MEASUREMENT_ID, GA4_API_SECRET,
#   GADS_CUSTOMER_ID, GADS_LOGIN_CUSTOMER_ID, GADS_CA_LEAD_QUALIFIED,
#   GADS_CA_BOOKING_CONFIRMED, GADS_CA_REVENUE_CONFIRMED,
#   TURNSTILE_SECRET_KEY, GADS_OAUTH_CLIENT_ID,
#   GADS_OAUTH_CLIENT_SECRET, GADS_DEVELOPER_TOKEN
#
# Előfeltétel: wrangler login már lefutott, vagy CLOUDFLARE_API_TOKEN env
# var be van állítva.

set -euo pipefail

PHASE="dev"          # dev | production
DRY_RUN=0
ONLY="all"           # all | kv | secrets
HOSTNAME="painlessremovals.com"

for arg in "$@"; do
  case "$arg" in
    --production) PHASE="production" ;;
    --dry-run)    DRY_RUN=1 ;;
    --only=kv)      ONLY="kv" ;;
    --only=secrets) ONLY="secrets" ;;
    --hostname=*) HOSTNAME="${arg#--hostname=}" ;;
    --help|-h)
      sed -n '3,30p' "$0"
      exit 0
      ;;
    *)
      echo "Ismeretlen kapcsoló: $arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v wrangler >/dev/null 2>&1; then
  echo "Hiba: wrangler CLI nincs telepítve. npm install -g wrangler" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Hiba: jq szükséges (JSON validációra). brew install jq / apt install jq" >&2
  exit 1
fi

ask_plain() {
  local var_name="$1"
  local prompt="$2"
  if [ -n "${!var_name:-}" ]; then
    return
  fi
  printf '%s: ' "$prompt"
  read -r value
  printf -v "$var_name" '%s' "$value"
}

ask_secret() {
  local var_name="$1"
  local prompt="$2"
  if [ -n "${!var_name:-}" ]; then
    return
  fi
  printf '%s (rejtett): ' "$prompt"
  read -rs value
  printf '\n'
  printf -v "$var_name" '%s' "$value"
}

run_or_print() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# 1. KV config
# ---------------------------------------------------------------------------

if [ "$ONLY" = "all" ] || [ "$ONLY" = "kv" ]; then
  echo "=== Painless KV config ($HOSTNAME) ==="

  ask_plain PIXEL_ID            "Painless Meta Pixel ID (16 jegyű)"
  ask_secret META_ACCESS_TOKEN  "Painless Meta CAPI access_token (System User)"
  ask_plain GA4_MEASUREMENT_ID  "Painless GA4 Measurement ID (G-XXXXXXXXXX)"
  ask_secret GA4_API_SECRET     "Painless GA4 Measurement Protocol API secret"
  ask_plain GADS_CUSTOMER_ID    "Painless Google Ads Customer ID (10 digit, no dashes)"
  ask_plain GADS_LOGIN_CUSTOMER_ID "Painless GAds login_customer_id (MCC ID, vagy üres ha nincs MCC)"
  # Modell 2: a szerver KIZÁRÓLAG offline (Enhanced Conversions for Leads)
  # Google Ads konverziót küld a CRM-fázisokra (lead-status webhook). A kulcsok
  # ezért az OFFLINE event-nevek (events.json kind:offline) — a régi on-site
  # nevekkel (phone_conversion stb.) a lookup MISSING_CONVERSION_ACTION-nel
  # csendben kimaradna. Lásd painless-config.template.json.
  ask_plain GADS_CA_LEAD_QUALIFIED    "Painless conversion_action ID — lead_qualified (offline)"
  ask_plain GADS_CA_BOOKING_CONFIRMED "Painless conversion_action ID — booking_confirmed (offline)"
  ask_plain GADS_CA_REVENUE_CONFIRMED "Painless conversion_action ID — revenue_confirmed (offline)"

  if [ "$PHASE" = "production" ]; then
    TEST_EVENT_BLOCK="null"
  else
    TEST_EVENT_BLOCK='"TEST_PAINLESS"'
  fi

  if [ -z "${GADS_LOGIN_CUSTOMER_ID:-}" ]; then
    LOGIN_CID_BLOCK="null"
  else
    LOGIN_CID_BLOCK="\"$GADS_LOGIN_CUSTOMER_ID\""
  fi

  CONFIG_JSON=$(jq -nc \
    --arg pixel_id        "$PIXEL_ID" \
    --arg meta_token      "$META_ACCESS_TOKEN" \
    --arg ga4_id          "$GA4_MEASUREMENT_ID" \
    --arg ga4_secret      "$GA4_API_SECRET" \
    --arg gads_cid        "$GADS_CUSTOMER_ID" \
    --argjson login_cid   "$LOGIN_CID_BLOCK" \
    --argjson test_code   "$TEST_EVENT_BLOCK" \
    --arg ca_lead_qualified    "$GADS_CA_LEAD_QUALIFIED" \
    --arg ca_booking_confirmed "$GADS_CA_BOOKING_CONFIRMED" \
    --arg ca_revenue_confirmed "$GADS_CA_REVENUE_CONFIRMED" \
    '{
      site_id: "painless",
      country_code: "GB",
      currency: "GBP",
      meta: (
        {
          pixel_id: $pixel_id,
          access_token: $meta_token
        }
        + (if $test_code == null then {} else { test_event_code: $test_code } end)
      ),
      ga4: {
        measurement_id: $ga4_id,
        api_secret: $ga4_secret
      },
      gads: {
        customer_id: $gads_cid,
        login_customer_id: $login_cid,
        conversion_actions: {
          lead_qualified: $ca_lead_qualified,
          booking_confirmed: $ca_booking_confirmed,
          revenue_confirmed: $ca_revenue_confirmed
        }
      }
    }')

  echo "Generált config JSON ($PHASE phase):"
  echo "$CONFIG_JSON" | jq .

  printf 'Feltöltöd a SITE_CONFIG KV-be a(z) "%s" kulcs alá? [y/N] ' "$HOSTNAME"
  read -r confirm
  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    # Pass the config JSON via a 0600-perm temp file (NOT argv) to avoid
    # leaking the Meta CAPI token + GA4 API secret to ps/proc/cmdline.
    CONFIG_TMP=$(mktemp)
    chmod 600 "$CONFIG_TMP"
    trap 'rm -f "$CONFIG_TMP"' EXIT INT TERM
    printf '%s' "$CONFIG_JSON" > "$CONFIG_TMP"
    run_or_print wrangler kv key put --binding=SITE_CONFIG "$HOSTNAME" --path="$CONFIG_TMP" --remote
    rm -f "$CONFIG_TMP"
    trap - EXIT INT TERM
    echo "KV feltöltés kész."
    if [ "$DRY_RUN" = "0" ]; then
      echo "Visszaolvasás:"
      wrangler kv key get --binding=SITE_CONFIG "$HOSTNAME" --remote --text | jq .
    fi
  else
    echo "KV feltöltés kihagyva."
  fi
fi

# ---------------------------------------------------------------------------
# 2. Wrangler secrets
# ---------------------------------------------------------------------------

put_secret() {
  local secret_name="$1"
  local prompt="$2"
  local var_name="$3"
  ask_secret "$var_name" "$prompt"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] echo \"<value>\" | wrangler secret put $secret_name"
  else
    printf '%s' "${!var_name}" | wrangler secret put "$secret_name"
  fi
}

if [ "$ONLY" = "all" ] || [ "$ONLY" = "secrets" ]; then
  echo
  echo "=== Wrangler secrets ==="

  put_secret TURNSTILE_SECRET_KEY    "Turnstile widget secret key"               TURNSTILE_SECRET_KEY
  put_secret GADS_OAUTH_CLIENT_ID    "Google Cloud OAuth Client ID"              GADS_OAUTH_CLIENT_ID
  put_secret GADS_OAUTH_CLIENT_SECRET "Google Cloud OAuth Client Secret"          GADS_OAUTH_CLIENT_SECRET
  put_secret GADS_DEVELOPER_TOKEN    "Google Ads Developer Token (jóváhagyott)"  GADS_DEVELOPER_TOKEN

  if [ "$DRY_RUN" = "0" ]; then
    echo
    echo "Beállított secret-ek:"
    wrangler secret list || true
  fi
fi

echo
echo "Setup kész. Következő lépések:"
echo "  1) wrangler deploy"
echo "  2) curl https://$HOSTNAME/api/event/health  (200 OK)"
echo "  3) ADMIN_API_TOKEN secret beállítása (oauth-init + debug routes-hoz):"
echo "     openssl rand -hex 32 | wrangler secret put ADMIN_API_TOKEN"
echo "  4) Browser OAuth flow indítása (admin-only):"
echo "     curl -L -H \"X-Admin-Token: \$ADMIN_API_TOKEN\" \\"
echo "       \"https://$HOSTNAME/api/event/oauth-init?customer_id=\$GADS_CUSTOMER_ID\""
echo "     (a Worker generál nonce-t és redirect-el Google consent oldalra)"
echo "  5) curl -H \"X-Admin-Token: \$ADMIN_API_TOKEN\" \\"
echo "       \"https://$HOSTNAME/api/event/oauth-debug?customer_id=\$GADS_CUSTOMER_ID\""
echo "     -> {\"access_token_received\": true}"
echo "  6) Sprint 9 előtt: ./scripts/setup-painless.sh --production --only=kv"
echo "     (test_event_code-ot kiveszi)"
