# Sprint 10 — Multi-tenant rollout 14 másik site-ra

**Cél:** A Sprint 9-ben Painless-en bizonyított stack-et átviszed a többi 14 oldalra.

**Idő Claude Code-dal:** 1-3 óra/site. **A Worker és az Astro lib már kész — csak konfiguráció + tesztelés.**

## Rollout sorrend ajánlása

| Hét | Site-ok |
|---|---|
| 1 | Painless live (Sprint 9 lezárása) |
| 2-3 | NemesVentilátorház + trapezlemezes.hu (Hungarian Tier 2) |
| 4-5 | BeautyFlow + szelloztessokosan.hu + olcsokontenerhaz.hu |
| 6-7 | SkinLab Hungary + Life Story Video |
| 8-9 | Bristol heat pump + Bristol house clearances + Bristol Cleaning Heroes |
| 10 | Egyéb (Balla Consulting, Painless Van & Car Valeting, kis projektek) |

**NE rohanj** — minden új site-on 4-7 nap megfigyelés mielőtt a következőre lépsz.

## Per-site checklist

### 1. KV config feltöltés (15 perc)

Példa NemesVentilátorház (Hungarian site):

```bash
wrangler kv:key put --binding=SITE_CONFIG "nemesventilatorhaz.hu" '{
  "site_id": "nemesvent",
  "country_code": "HU",
  "currency": "HUF",
  "meta": {
    "pixel_id": "<NEMESVENT_PIXEL_ID>",
    "access_token": "<NEMESVENT_CAPI_TOKEN>"
  },
  "ga4": {
    "measurement_id": "<NEMESVENT_GA4_ID>",
    "api_secret": "<NEMESVENT_GA4_API_SECRET>"
  },
  "gads": {
    "customer_id": "<NEMESVENT_CUSTOMER_ID>",
    "login_customer_id": null,
    "conversion_actions": {
      "quote_calculator_conversion": "<ACTION_ID>",
      "callback_conversion": "<ACTION_ID>",
      "contact_form_submit": "<ACTION_ID>",
      "phone_conversion": "<ACTION_ID>",
      "email_conversion": "<ACTION_ID>",
      "whatsapp_conversion": "<ACTION_ID>"
    }
  }
}'
```

### 2. Wrangler routes bővítés (10 perc)

`wrangler.toml`:

```toml
[[routes]]
pattern = "nemesventilatorhaz.hu/api/track/*"
zone_name = "nemesventilatorhaz.hu"

[[routes]]
pattern = "www.nemesventilatorhaz.hu/api/track/*"
zone_name = "nemesventilatorhaz.hu"
```

Deploy: `wrangler deploy`

### 3. OAuth flow per ügyfél (10-15 perc, csak ha Google Ads CAPI is)

Browser:
```
https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=https%3A%2F%2Fnemesventilatorhaz.hu%2Fapi%2Ftrack%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords&access_type=offline&prompt=consent&state=<NEMESVENT_CUSTOMER_ID>
```

Sign in with the **Google Ads account owner email** (lehet Kelemen Zsolt account-ja). Approve.

Verify: `curl 'https://nemesventilatorhaz.hu/api/track/oauth-debug?customer_id=<NEMESVENT_CUSTOMER_ID>'`

Ha az ügyfél **NEM használ** Google Ads-t (csak Meta + GA4): kihagyhatod, `gads.conversion_actions` üres `{}` map-pel marad.

### 4. Astro projekt módosítás (30-60 perc)

a) **Másold át** a Painless `src/lib/worker-tracking.ts`-t és `src/lib/uuid.ts`-t.

b) **Add hozzá** a Turnstile widget-et a `BaseLayout.astro`-ban.

c) **Environment variable**: `PUBLIC_TURNSTILE_SITE_KEY` Cloudflare Pages secret-be (lehet ugyanaz, mint Painless-en).

d) **Forms módosítás**: minden konverziós event-et `trackConversion()`-on keresztül indíts el.

e) **GTM container módosítás**:
   - Google Ads conversion tagek eltávolítva
   - GA4 conversion tagek eltávolítva
   - Meta Pixel `Lead`/`Contact` tagek `eventID` field hozzáadva
   - Engagement event tagek (page_view, scroll, video) maradnak

f) **Backup**: a régi GTM container JSON exportja Sprint 10 elején.

### 5. Smoke test (15-30 perc)

- Live form submission
- Network tab: `/api/track/conversion` → 204
- Worker logs: "Fan-out completed" minden platformra
- Meta Events Manager Test Events: új event "Browser AND Server"
- GA4 Real-time: új event server-side
- Google Ads (24-48 óra): Diagnostics "Recording"

### 6. 1 hét megfigyelés

Per site:
- Conversion volume nem csökken
- ROAS stabil
- Worker logs tisztaak
- DLQ üres

## Sprint 10 utáni állapot

- ✅ Mind a 15 site (Painless + 14) production-on
- ✅ $0/hó hosting (Cloudflare Workers Paid plan-en belül)
- ✅ Egységes monitoring + DLQ
- ✅ Új ügyfél onboarding 1-2 óra (KV config + OAuth + Astro módosítás)

## Új ügyfél felvétele Sprint 10 után

A **build once, deploy everywhere** pattern teljes. Új ügyfél felvétele:

1. KV config feltöltés (15 perc)
2. Wrangler route hozzáadás (5 perc)
3. OAuth flow (10 perc, csak ha Google Ads)
4. Astro projekt: `worker-tracking.ts` + Turnstile widget másolás (30 perc)
5. Smoke test (30 perc)

**Total: ~1.5 óra új ügyfél onboarding**, $0 marginális hosting cost.

## Mit KÉRDEZZ a usertől

1. Painless Sprint 9 lezárt (1 hét stabil)?
2. Melyik site jön következőnek a rollout-ban?
3. Az adott site Pixel ID, GA4 Measurement ID, Google Ads customer ID + conversion action ID-k összegyűjtve?
4. Astro projekt elérhető git-en?
