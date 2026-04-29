#!/usr/bin/env bash
#
# setup-painless.sh — interaktív (vagy env-based) setup script a Painless
# Soborbo Tracking Worker-konfigurációhoz.
#
# Mit csinál:
#   1) Lekér minden szükséges Painless adatot (Pixel ID, Meta CAPI token,
#      GA4 measurement_id + secret, GAds customer_id + 6 conversion action,
#      Turnstile secret, OAuth client + secret, GAds developer token).
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
#   GADS_CUSTOMER_ID, GADS_LOGIN_CUSTOMER_ID, GADS_CA_QUOTE,
#   GADS_CA_CALLBACK, GADS_CA_CONTACT, GADS_CA_PHONE, GADS_CA_EMAIL,
#   GADS_CA_WHATSAPP, TURNSTILE_SECRET_KEY, GADS_OAUTH_CLIENT_ID,
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
    echo "[dry-run] $*"
  else
    eval "$@"
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
  ask_plain GADS_CA_QUOTE       "Painless conversion_action ID — quote_calculator_conversion"
  ask_plain GADS_CA_CALLBACK    "Painless conversion_action ID — callback_conversion"
  ask_plain GADS_CA_CONTACT     "Painless conversion_action ID — contact_form_submit"
  ask_plain GADS_CA_PHONE       "Painless conversion_action ID — phone_conversion"
  ask_plain GADS_CA_EMAIL       "Painless conversion_action ID — email_conversion"
  ask_plain GADS_CA_WHATSAPP    "Painless conversion_action ID — whatsapp_conversion"

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
    --arg ca_quote        "$GADS_CA_QUOTE" \
    --arg ca_callback     "$GADS_CA_CALLBACK" \
    --arg ca_contact      "$GADS_CA_CONTACT" \
    --arg ca_phone        "$GADS_CA_PHONE" \
    --arg ca_email        "$GADS_CA_EMAIL" \
    --arg ca_whatsapp     "$GADS_CA_WHATSAPP" \
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
          quote_calculator_conversion: $ca_quote,
          callback_conversion: $ca_callback,
          contact_form_submit: $ca_contact,
          phone_conversion: $ca_phone,
          email_conversion: $ca_email,
          whatsapp_conversion: $ca_whatsapp
        }
      }
    }')

  echo "Generált config JSON ($PHASE phase):"
  echo "$CONFIG_JSON" | jq .

  printf 'Feltöltöd a SITE_CONFIG KV-be a(z) "%s" kulcs alá? [y/N] ' "$HOSTNAME"
  read -r confirm
  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    run_or_print "wrangler kv key put --binding=SITE_CONFIG \"$HOSTNAME\" '$CONFIG_JSON' --remote"
    echo "KV feltöltés kész."
    if [ "$DRY_RUN" = "0" ]; then
      echo "Visszaolvasás:"
      wrangler kv key get --binding=SITE_CONFIG "$HOSTNAME" --remote | jq .
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
echo "  2) curl https://$HOSTNAME/api/track/health  (200 OK)"
echo "  3) Browser OAuth flow Painless customer_id-vel (Sprint 6 spec):"
echo "     https://accounts.google.com/o/oauth2/v2/auth?client_id=\$CLIENT_ID&redirect_uri=https%3A%2F%2F$HOSTNAME%2Fapi%2Ftrack%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords&access_type=offline&prompt=consent&state=\$GADS_CUSTOMER_ID"
echo "  4) curl 'https://$HOSTNAME/api/track/oauth-debug?customer_id=\$GADS_CUSTOMER_ID'"
echo "     -> {\"access_token_received\": true}"
echo "  5) Sprint 9 előtt: ./scripts/setup-painless.sh --production --only=kv"
echo "     (test_event_code-ot kiveszi)"
