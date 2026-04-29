# 00. Pre-sprint setup — manuális Cloudflare lépések

**Idő:** 30-45 perc, csak egyszer.

Mielőtt Claude Code-ot elindítod a Sprint 1-en, ezeket te csinálod kézzel a Cloudflare dashboard-on és a Google Cloud Console-on.

## 1. Cloudflare API Token

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template.

- **Account**: a fő Soborbo account
- **Zone**: legalább a `painlessremovals.com` és `beautyflow.pro` zone-ok kiválasztva (vagy akármelyik első site, amire deploy-olsz)
- **Permissions**: Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, Account Settings:Read, Zone:Read

Mentsd el a token-t valahova biztonságosan (1Password vagy hasonló). Ezt fogja használni a Wrangler CLI.

## 2. R2 Bucket létrehozása

Cloudflare dashboard → R2 → Create bucket:

- **Név**: `soborbo-tracking-dlq`
- **Régió**: **EU (Belgium)** (GDPR miatt, és Painless UK ügyfél)

## 3. KV namespace-ek létrehozása

Cloudflare dashboard → Workers & Pages → KV → Create namespace × 2:

1. Név: `soborbo-tracking-site-config`
2. Név: `soborbo-tracking-oauth-tokens`

Mindegyik létrehozása után **másold ki az ID-t** (32-karakteres hex string). Ezeket beillesztjük a `wrangler.toml`-ba a Sprint 1-ben.

## 4. Turnstile widget kreálás

Cloudflare dashboard → Turnstile → Add site:

- **Site name**: `Soborbo Tracking`
- **Domain**: `painlessremovals.com` (és add hozzá `beautyflow.pro`-t és bármilyen egyéb domain-t, amit a 15 site listából tudsz)
- **Widget mode**: **Invisible**

Mentsd el:
- **Site Key** (publikus, az Astro front-endbe megy `PUBLIC_TURNSTILE_SITE_KEY` változóként)
- **Secret Key** (privát, Worker secret lesz a Sprint 2-ben)

## 5. Cloudflare Account ID

Cloudflare dashboard → bármelyik zone-on, jobb oldali sidebar → **Account ID**. Másold ki.

## 6. Google Cloud projekt OAuth credentials (Sprint 6-hoz, de érdemes most megcsinálni)

Google Cloud Console → új projekt vagy meglévő Soborbo projekt → APIs & Services → **Enable Google Ads API**.

Aztán: APIs & Services → Credentials → Create Credentials → OAuth client ID:

- **Application type**: Web application
- **Name**: `Soborbo Tracking Worker`
- **Authorized redirect URIs**:
  - `https://painlessremovals.com/api/event/oauth-callback`
  - `https://beautyflow.pro/api/event/oauth-callback`
  - (Add hozzá minden további site-ot, ahol Google Ads CAPI lesz)

Mentsd el:
- **Client ID** (`123456789-abc...apps.googleusercontent.com`)
- **Client Secret** (`GOCSPX-...`)

## 7. Google Ads Developer Token application (ha még nincs)

**Ha** Painless-en akarsz Google Ads CAPI-t: Google Ads → Tools → API Center → Apply for Basic access.

- Várakozási idő: **2-8 hét** Google jóváhagyás
- Approval után: másold ki a developer token-t — ez lesz a `GADS_DEVELOPER_TOKEN` Wrangler secret a Sprint 7-ben

**Ha még nem indítottad el**: indítsd el most. A Sprint 7 blokkolva lesz nélküle, de Sprint 1-6 + Sprint 8 + Sprint 9 (Meta + GA4 oldalon) tovább haladhat anélkül.

## 8. Painless adatok összegyűjtése (Sprint 4-7-hez)

Ezeket gyűjtsd össze, hogy a Sprint 4-7 alatt kéznél legyen:

| Mit | Hol találod |
|---|---|
| Painless Pixel ID | Meta Events Manager → Painless Pixel → bal felső sarok 16-jegyű szám |
| Painless CAPI Access Token | Meta Events Manager → Painless Pixel → Settings → Conversions API → Generate |
| Painless GA4 Measurement ID | GA4 Admin → Data Streams → Painless stream → Measurement ID (`G-XXXXXXXXXX`) |
| Painless GA4 API Secret | GA4 Admin → Data Streams → Painless stream → Measurement Protocol API secrets → Create |
| Painless Google Ads Customer ID | Google Ads → Painless account → Settings → Account → 10-digit Customer ID (dashe-ek nélkül) |
| Painless Google Ads Login Customer ID (csak ha MCC alatt van) | A te MCC account ID-d |
| Painless 6 Conversion Action ID | Google Ads → Goals → Conversions → minden action → "Tag setup" → ID a `send_to: AW-XXX/<ID>` második része |

## 9. Wrangler CLI telepítés

Lokálisan:

```bash
npm install -g wrangler
wrangler login
```

Login a Cloudflare account-tal, ami a Soborbo workspace-t kezeli.

## 10. Repo létrehozása

```bash
cd ~/projects
mkdir soborbo-tracking-worker
cd soborbo-tracking-worker
git init
```

## Checklist mielőtt Sprint 1-et elindítod

- [ ] Cloudflare API Token mentve
- [ ] R2 bucket `soborbo-tracking-dlq` létrehozva
- [ ] KV namespace `soborbo-tracking-site-config` létrehozva, ID mentve
- [ ] KV namespace `soborbo-tracking-oauth-tokens` létrehozva, ID mentve
- [ ] Turnstile widget létrehozva, Site Key + Secret Key mentve
- [ ] Cloudflare Account ID mentve
- [ ] Google Cloud OAuth Client ID + Secret mentve
- [ ] Google Ads developer token application: jóváhagyott vagy elindítva
- [ ] Painless Pixel ID + CAPI token mentve
- [ ] Painless GA4 Measurement ID + API Secret mentve
- [ ] Painless Google Ads Customer ID + 6 Conversion Action ID mentve
- [ ] Wrangler CLI telepítve, login megtörtént
- [ ] Repo létrehozva

Ha mind ✅, mehet a Sprint 1.
