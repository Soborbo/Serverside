#!/usr/bin/env bash
# Google Ads re-consent — a Google beleegyezési URL kinyerése EGY customer_id-re.
#
# MIÉRT NEM MEGY BÖNGÉSZŐBŐL KÖZVETLENÜL: a /api/event/oauth-init `authenticateAdmin`
# mögött van, ami KIZÁRÓLAG az `X-Admin-Token` FEJLÉCET nézi (admin-auth.ts) — a
# böngésző címsorából fejlécet nem lehet küldeni, a hívás 404-et adna. Ezért:
#   1) curl-lel elkérjük a 302 `Location`-t (a Google consent URL-je),
#   2) AZT nyitjuk meg böngészőben és fejezzük be a beleegyezést,
#   3) a Google a /api/event/oauth-callback-re tér vissza, ami elmenti a refresh tokent.
#
# A state nonce TTL-je 10 PERC (oauth-state.ts) — ezért EGYSZERRE EGY customer_id,
# és a böngészős lépést rögtön utána kell megcsinálni. Ne kérd le mind a hatot előre.
#
# Használat:
#   export ADMIN_API_TOKEN='...'
#   bash reconsent.sh 9796138635              # beautyflow — EZZEL KEZDD
#   bash reconsent.sh 9796138635 painlessremovals.com   # más gateway-host
set -euo pipefail

CID="${1:?customer_id kell (10 számjegy, kötőjel nélkül)}"
# A HOST szabja meg a redirect_uri-t (`${url.origin}/api/event/oauth-callback`),
# ezért ANNAK a hostnak szerepelnie KELL a GCP OAuth-kliens engedélyezett redirect
# URI-jai között. Ha a Google „redirect_uri_mismatch"-et ad, itt a teendő: vagy
# másik hostot adj meg, vagy vedd fel a GCP-ben.
HOST="${2:-painlessremovals.com}"
: "${ADMIN_API_TOKEN:?export ADMIN_API_TOKEN='...' kell}"

echo "customer_id=$CID  gateway-host=$HOST"
echo

LOC="$(curl -sS -o /dev/null -D - \
        -H "X-Admin-Token: $ADMIN_API_TOKEN" \
        "https://$HOST/api/event/oauth-init?customer_id=$CID" \
      | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"

if [ -z "$LOC" ]; then
  echo "!! Nem jött Location fejléc."
  echo "   404  → rossz/hiányzó ADMIN_API_TOKEN (a route auth nélkül 404-et ad, nem 401-et)"
  echo "   400  → a customer_id nem 10 számjegy"
  echo "   egyéb → nézd meg nyersen:"
  echo "     curl -i -H \"X-Admin-Token: \$ADMIN_API_TOKEN\" 'https://$HOST/api/event/oauth-init?customer_id=$CID'"
  exit 1
fi

echo "Nyisd meg EZT böngészőben (10 percen belül!):"
echo
echo "$LOC"
echo
echo "A beleegyezés után a Google a /api/event/oauth-callback-re tér vissza,"
echo "és a refresh token elmentődik. A scope-hármas: datamanager + adwords +"
echo "analytics.readonly — az utóbbi élesíti a GA4 recon-leget."
