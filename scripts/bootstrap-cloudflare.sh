#!/usr/bin/env bash
#
# bootstrap-cloudflare.sh — a Worker Cloudflare-INFRASTRUKTÚRÁJÁNAK provisionálása
# egy friss fiókon, és a wrangler.toml ID-k bepatchelése. Ez az a lépés, ami
# eddig kézi toml-szerkesztést igényelt (lásd DEPLOY.md, deploy-audit).
#
# Létrehozza (ha még nincs): 2 KV namespace (SITE_CONFIG, OAUTH_TOKENS),
# 1 R2 bucket (soborbo-tracking-dlq), 1 D1 DB (event-gateway-ledger), majd
# alkalmazza a migrations/0001_ledger.sql sémát és beírja az ID-kat a wrangler.toml-ba.
#
# Idempotens: meglévő erőforrást nem hoz létre újra (név alapján). Csak a
# wrangler.toml ID-ket frissíti.
#
# Használat:
#   ./scripts/bootstrap-cloudflare.sh                # provisionál + patchel
#   ./scripts/bootstrap-cloudflare.sh --dry-run      # csak kiírja, mit tenne
#
# Előfeltétel: wrangler login VAGY CLOUDFLARE_API_TOKEN env var.
# Megjegyzés: ha Claude Code futtatja Cloudflare MCP-vel, a kv_namespace_create /
# r2_bucket_create / d1_database_create / d1_database_query toolok ugyanezt
# strukturált (parse-mentes) módon elvégzik — lásd DEPLOY.md.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "Ismeretlen kapcsoló: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOML="$ROOT/wrangler.toml"
R2_BUCKET="soborbo-tracking-dlq"
D1_NAME="event-gateway-ledger"

command -v wrangler >/dev/null 2>&1 || { echo "Hiba: wrangler nincs telepítve." >&2; exit 1; }

run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*"; else eval "$@"; fi; }

# A wrangler 'create' kimenetéből kiszedi az `id = "..."` (KV) vagy
# `database_id = "..."` (D1) értéket; létező erőforrásnál a 'list'-ből.
extract_id() { grep -oE '[0-9a-f]{32}|[0-9a-f-]{36}' | head -n1; }

patch_toml() { # $1=marker regex előtag, $2=új id
  local key="$1" id="$2"
  if [ "$DRY_RUN" = 1 ]; then echo "DRY: patch $key -> $id"; return; fi
  # Az adott binding blokkjában cseréli az id sort (GNU sed).
  sed -i -E "s|^(\\s*${key}\\s*=\\s*\")[^\"]*(\")|\\1${id}\\2|" "$TOML"
}

echo "== KV namespaces =="
for binding in SITE_CONFIG OAUTH_TOKENS; do
  existing="$(wrangler kv namespace list 2>/dev/null | grep -oE "\"id\":\\s*\"[0-9a-f]{32}\"[^}]*\"title\":\\s*\"[^\"]*${binding}\"" | grep -oE '[0-9a-f]{32}' | head -n1 || true)"
  if [ -n "$existing" ]; then
    echo "  $binding már létezik: $existing"
    id="$existing"
  else
    if [ "$DRY_RUN" = 1 ]; then echo "DRY: wrangler kv namespace create $binding"; id="<new-$binding-id>"; else
      id="$(wrangler kv namespace create "$binding" 2>&1 | extract_id)"
      echo "  $binding létrehozva: $id"
    fi
  fi
  [ "$binding" = "SITE_CONFIG" ] && patch_toml "id" "$id" && SITE_ID_DONE=1 || true
done
echo "  (megj.: ha mindkét KV id-t patchelni kell, a wrangler.toml-ban a két [[kv_namespaces]] blokk sorrendje SITE_CONFIG majd OAUTH_TOKENS — ellenőrizd a patch-et)"

echo "== R2 bucket =="
if wrangler r2 bucket list 2>/dev/null | grep -q "$R2_BUCKET"; then
  echo "  $R2_BUCKET már létezik"
else
  run "wrangler r2 bucket create \"$R2_BUCKET\""
fi

echo "== D1 database =="
d1id="$(wrangler d1 list --json 2>/dev/null | grep -oE "\"uuid\":\\s*\"[0-9a-f-]{36}\"[^}]*\"name\":\\s*\"${D1_NAME}\"|\"name\":\\s*\"${D1_NAME}\"[^}]*\"uuid\":\\s*\"[0-9a-f-]{36}\"" | extract_id || true)"
if [ -n "$d1id" ]; then
  echo "  $D1_NAME már létezik: $d1id"
else
  if [ "$DRY_RUN" = 1 ]; then echo "DRY: wrangler d1 create $D1_NAME"; d1id="<new-d1-id>"; else
    d1id="$(wrangler d1 create "$D1_NAME" 2>&1 | extract_id)"
    echo "  $D1_NAME létrehozva: $d1id"
  fi
fi
patch_toml "database_id" "$d1id"

echo "== D1 migráció =="
run "wrangler d1 migrations apply \"$D1_NAME\" --remote"

echo ""
echo "Kész. Ellenőrizd a wrangler.toml ID-ket, majd: wrangler deploy"
echo "A KV SITE_CONFIG seedeléséhez: scripts/setup-painless.sh (lásd DEPLOY.md)."
