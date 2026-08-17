#!/usr/bin/env bash
# KV-írások a #59 cél-állapotához + manifest-ellenőrzés.
# A repó gyökeréből futtatandó, bejelentkezett wranglerrel.
set -euo pipefail

NS=edd34e28eee847c09c26f9d9e3ea04ab
cd "$(git rev-parse --show-toplevel)"

# A 4. lépés a MUNKAFÁD `src/site-manifest.json`-jához hasonlít. Ha nem a main-en
# állsz (pl. azon az ágon, ahonnan ez a szkript jött), egy elavult manifesthez
# mérnénk — a `pull --ff-only origin main` pedig itt vagy elhasal, vagy nem azt
# csinálja, amit vársz.
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "!! nem a main-en állsz — válts át: git checkout main"; exit 1; }
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

# ── előfeltétel: a wrangler CLI érti-e a használt flageket? ──────────────────
# A `kvput` szintaxisa csak az ÍRÁSI ciklusban derülne ki — ott viszont egy
# rossz flag már a hatodik hostnál tartana, apex-írt/www-íratlan párokkal.
# Egy `--help` grep írás nélkül eldönti.
for flag in --path --namespace-id --remote; do
  # 2>&1, NEM 2>/dev/null: sok CLI a súgót a stderr-re írja. Eldobva a grep üres
  # bemenetet kapna, és a szkript „elavult szintaxis" indoklással állna meg egy
  # támogatott flagnél — helyes leállás, hamis ok.
  npx wrangler kv key put --help 2>&1 | grep -q -- "$flag" \
    || { echo "!! a wrangler kv key put nem ismeri a $flag flaget ezen a verzión — állj meg, a szkript szintaxisa elavult"; exit 1; }
done

# ── 0. lépés: READ-ONLY előellenőrzés ────────────────────────────────────────
# Ha az apex és a www már most eltér, azt TUDNI kell, mielőtt bármit felülírunk.
echo "── előellenőrzés ──"
MISMATCH=""
for host in $SITES; do
  kvget "$host"       > "$TMP/apex.json"
  kvget "www.$host"   > "$TMP/www.json"
  if cmp -s "$TMP/apex.json" "$TMP/www.json"; then eq="apex==www"; else eq="!! APEX≠WWW !!"; MISMATCH="$MISMATCH $host"; fi
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

  # Az eltérést nem elég JELEZNI. Az írási ciklus az APEX-ből származó merge-t
  # teszi le MINDKÉT kulcsra — ha a www-ben van olyan mező, ami az apexben
  # nincs, az nyomtalanul eltűnne. Ezért itt megmutatjuk a kulcshalmaz-
  # különbséget (értéket NEM: titok lehet benne), és külön megerősítést kérünk.
  if [ -n "$eq" ] && [ "$eq" != "apex==www" ]; then
    node -e '
      const fs = require("fs");
      const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const w = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const ka = Object.keys(a).sort(), kw = Object.keys(w).sort();
      console.log("   apex-only kulcsok:", ka.filter((k) => !kw.includes(k)).join(",") || "–");
      console.log("   www-only kulcsok: ", kw.filter((k) => !ka.includes(k)).join(",") || "–");
      console.log("   eltérő értékű:    ", ka.filter((k) => kw.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(w[k])).join(",") || "–");
    ' "$TMP/apex.json" "$TMP/www.json"
  fi
done
echo

# Az eltérő párokra hostonként külön kell rábólintani — a meg nem erősített
# hostok KIMARADNAK az írásból (nem félig íródnak).
SKIP_HOSTS=""
for host in $MISMATCH; do
  read -r -p "!! $host: az apex és a www ELTÉR. Az írás a www-t az apex tartalmára cseréli. Mehet? (igen/nem) " okh
  [ "$okh" = "igen" ] || { SKIP_HOSTS="$SKIP_HOSTS $host"; echo "   → $host KIMARAD"; }
done

read -r -p "Mehet az írás? (igen/nem) " ok
[ "$ok" = "igen" ] || { echo "megszakítva"; exit 1; }

# ── 1-2. lépés: a patch beolvasztása, apex + www BÁJTRA azonosan ─────────────
for host in $SITES; do
  case " $SKIP_HOSTS " in *" $host "*) echo "– $host kihagyva"; continue;; esac
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

  # A két írás közti bukás FÉLBEMARADT párt hagy — ezt ki kell mondani, nem
  # elég `set -e`-vel kilépni: a helyreállításhoz tudni kell, melyik kulcs friss.
  kvput "$host" "$TMP/new.json" \
    || { echo "!! $host apex írása elhasalt — ezen a hoston semmi nem változott"; exit 1; }
  kvput "www.$host" "$TMP/new.json" \
    || { echo "!! FÉLBEMARADT: $host FRISSÜLT, www.$host NEM. A kettő most eltér — futtasd újra, vagy másold át kézzel."; exit 1; }
  echo "✓ $host + www.$host"
done

# ── 3. lépés: manifest újragenerálás ────────────────────────────────────────
# A generátor kimenete titok-mentes (a meta.access_token / ga4.api_secret a saját
# sha256-jukra cserélve), tehát NEM tartozik a temp-védelem alá — és nem is
# szabad a $TMP-be tenni: a 4. lépés eltérés-ága `exit 1`-gyel megy ki, a `trap`
# letörölné pont azt a fájlt, amit meg akarsz nézni. Gitignore-olt, tartós út.
# A NYERS configokat továbbra is CSAK pipe viszi — fájlba sosem.
node scripts/fetch-kv-configs.mjs "$NS" \
  | node scripts/gen-site-manifest.mjs --commit "$(git rev-parse HEAD)" \
  > site-manifest.generated.json

# ── 4. lépés: egyezik-e a #59-ben lévővel? ───────────────────────────────────
# A `source_commit` SZÁNDÉKOSAN kimarad az összevetésből: a #59-beli manifest
# 8a5dbbd-vel készült, a mostani 5ece5f4-gyel. A `sites` blokknak kell egyeznie.
SKIP_HOSTS="$SKIP_HOSTS" node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync("src/site-manifest.json", "utf8")).sites;
  const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).sites;
  // A szándékosan kihagyott hostok KV-ja változatlan maradt, tehát jogosan
  // térnek el — a riport mondja meg, ne az olvasónak kelljen emlékeznie rá.
  const skipped = new Set();
  for (const h of (process.env.SKIP_HOSTS || "").trim().split(/\s+/).filter(Boolean)) {
    skipped.add(h); skipped.add("www." + h);
  }
  const hosts = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = hosts.filter((h) => a[h] !== b[h]);
  if (!diffs.length) { console.log("✓ a KV és a #59 manifestje EGYEZIK (" + hosts.length + " host)"); process.exit(0); }
  const real = diffs.filter((h) => !skipped.has(h));
  console.log("!! ELTÉRÉS " + diffs.length + " hoston (ebből " + (diffs.length - real.length) + " szándékosan kihagyott):");
  for (const h of diffs) {
    console.log("   " + h + (skipped.has(h) ? "   ← SZÁNDÉKOSAN kihagyva, nem hiba" : "") +
      "\n     manifest: " + (a[h] ?? "<hiányzik>") + "\n     élő KV:   " + (b[h] ?? "<hiányzik>"));
  }
  console.log("   A friss manifest: site-manifest.generated.json (megmarad, gitignore-olt)");
  process.exit(real.length ? 1 : 0);
' site-manifest.generated.json

# Ha egyezik, a repóban semmit nem kell módosítani. Ha eltér, a friss manifest
# MEGMARAD (`site-manifest.generated.json`, gitignore-olt) — nézd meg a fenti
# listát, és csak akkor másold be, ha érted, MIÉRT tér el:
#   cp site-manifest.generated.json src/site-manifest.json
