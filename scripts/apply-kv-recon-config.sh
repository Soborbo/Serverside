#!/usr/bin/env bash
# KV-írások a #59 cél-állapotához + manifest-ellenőrzés.
# A repó gyökeréből futtatandó, bejelentkezett wranglerrel.
set -euo pipefail

NS=edd34e28eee847c09c26f9d9e3ea04ab
cd "$(git rev-parse --show-toplevel)"
git pull --ff-only origin main            # HEAD legyen 5ece5f4 (a #59 merge)

# A nyers configok TITKOT tartalmaznak (meta.access_token, ga4.api_secret).
# Sose fájlba, sose argv-be: 0600-as temp könyvtár, kilépéskor törölve.
umask 077
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

kvget() { npx wrangler kv key get "$1" --namespace-id="$NS" --remote --text; }
kvput() { npx wrangler kv key put "$1" --namespace-id="$NS" --remote --path="$2"; }

# site → patch. A ga4_property_id STRING (a SiteConfig típusa `string`);
# számként írva a leg csendben elszáll.
patch_for() {
  case "$1" in
    painlessremovals.com) echo '{"expected_platforms":{"smoke":["meta"],"offline":["gads"]},"recon":{"ga4_property_id":"413271735"}}';;
    lomtalan.hu)          echo '{"expected_platforms":{"smoke":["meta"],"offline":["gads"]},"recon":{"ga4_property_id":"270977444"}}';;
    beautyflow.pro)       echo '{"expected_platforms":{"smoke":["meta"],"offline":["gads"]},"recon":{"ga4_property_id":"495936197"}}';;
    olcsokontenerhaz.hu)  echo '{"recon":{"ga4_property_id":"468363735"}}';;
    skinlabhungary.hu)    echo '{"recon":{"ga4_property_id":"488472743"}}';;
    trapezlemezes.hu)     echo '{"recon":{"ga4_property_id":"449987171"}}';;
  esac
}
SITES="painlessremovals.com lomtalan.hu beautyflow.pro olcsokontenerhaz.hu skinlabhungary.hu trapezlemezes.hu"

# ── 0. lépés: READ-ONLY előellenőrzés ────────────────────────────────────────
# Ha az apex és a www már most eltér, azt TUDNI kell, mielőtt bármit felülírunk.
echo "── előellenőrzés ──"
for host in $SITES; do
  kvget "$host"       > "$TMP/apex.json"
  kvget "www.$host"   > "$TMP/www.json"
  if cmp -s "$TMP/apex.json" "$TMP/www.json"; then eq="apex==www"; else eq="!! APEX≠WWW !!"; fi
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    // CSAK nem-titkos mezők — a country_code kérdés is itt dől el.
    console.log(
      process.argv[2].padEnd(22),
      process.argv[3].padEnd(14),
      "country_code=" + JSON.stringify(c.country_code),
      // A `meta` blokk megléte KRITIKUS: az expected_platforms felírása AKTIVÁLJA
      // a védőláncot. Ha egy site-ra `smoke:["meta"]`-t írunk, de nincs meta
      // configja, a következő eventje `not_configured` skipet ad → DLQ + CRITICAL.
      // Itt `meta=NINCS` mellett NE írj — előbb a configot kell pótolni.
      "meta=" + (c.meta ? "van" : "NINCS"),
      "gads.customer_id=" + (c.gads?.customer_id ? "van" : "NINCS"),
      "expected_platforms=" + (c.expected_platforms ? "van" : "nincs"),
      "recon=" + (c.recon ? "van" : "nincs")
    );
  ' "$TMP/apex.json" "$host" "$eq"
done
echo
read -r -p "Mehet az írás? (igen/nem) " ok
[ "$ok" = "igen" ] || { echo "megszakítva"; exit 1; }

# ── 1-2. lépés: a patch beolvasztása, apex + www BÁJTRA azonosan ─────────────
for host in $SITES; do
  kvget "$host" > "$TMP/cur.json"
  patch_for "$host" > "$TMP/patch.json"
  node -e '
    const fs = require("fs");
    const cur = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const patch = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    // Sekély merge blokk-szinten: a `recon` meglévő mezői (pl. a kézzel
    // felvett gads_onsite_actions) megmaradnak.
    for (const [k, v] of Object.entries(patch)) {
      cur[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(cur[k] || {}), ...v } : v;
    }
    fs.writeFileSync(process.argv[3], JSON.stringify(cur));
  ' "$TMP/cur.json" "$TMP/patch.json" "$TMP/new.json"

  kvput "$host"     "$TMP/new.json"
  kvput "www.$host" "$TMP/new.json"     # UGYANAZ a bájtsor
  echo "✓ $host + www.$host"
done

# ── 3. lépés: manifest újragenerálás (csak pipe-ban!) ────────────────────────
node scripts/fetch-kv-configs.mjs "$NS" \
  | node scripts/gen-site-manifest.mjs --commit "$(git rev-parse HEAD)" \
  > "$TMP/manifest.json"

# ── 4. lépés: egyezik-e a #59-ben lévővel? ───────────────────────────────────
# A `source_commit` SZÁNDÉKOSAN kimarad az összevetésből: a #59-beli manifest
# 8a5dbbd-vel készült, a mostani 5ece5f4-gyel. A `sites` blokknak kell egyeznie.
node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync("src/site-manifest.json", "utf8")).sites;
  const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).sites;
  const hosts = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = hosts.filter((h) => a[h] !== b[h]);
  if (!diffs.length) { console.log("✓ a KV és a #59 manifestje EGYEZIK (" + hosts.length + " host)"); process.exit(0); }
  console.log("!! ELTÉRÉS " + diffs.length + " hoston — a KV még mindig más, mint amit a manifest elvár:");
  for (const h of diffs) console.log("   " + h + "\n     manifest: " + (a[h] ?? "<hiányzik>") + "\n     élő KV:   " + (b[h] ?? "<hiányzik>"));
  process.exit(1);
' "$TMP/manifest.json"

# Ha egyezik, a repóban semmit nem kell módosítani. Ha eltér, a friss manifest
# ITT van (a temp törlődik kilépéskor) — nézd meg a fenti listát, és csak akkor
# másold be, ha érted, MIÉRT tér el:
#   cp "$TMP/manifest.json" src/site-manifest.json
