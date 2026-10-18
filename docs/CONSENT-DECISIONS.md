# Hozzájárulási döntések — hol születnek, melyik szabály szerint

Állapot: 2026-10-18 (review-egységesítés, 6.13.0). Ez a térkép a kód párja: ha
egy új út hirdetési vagy analitikai kézbesítésről dönt, ide kerül, és a meglévő
közös függvényt hívja.

## A négy kimenet

| Kimenet | Jelentés | Hatás |
|---|---|---|
| engedélyezett | bizonyított döntés engedi a kategóriát | küldés, a bizonyított Consent Mode jelekkel |
| tiltott | a döntés tiltja (vagy visszavonta) | `skipped` (`consent_denied` / `consent_withdrawn`), terminális |
| új döntés szükséges | a site szabálya szerint nincs érvényes döntés | `skipped` (`consent_missing_failclosed`), terminális, nincs küldés |
| átmenetileg nem ellenőrizhető | D1-olvasási hiba | NINCS küldés és NINCS végleges kihagyás: 503 / újrapróbálható retry |

Adatbázishiba soha nem válik engedéllyé, és nem okoz végleges eseményvesztést.

## Döntési pontok

| Pont | Hol | Szabály |
|---|---|---|
| Banner / böngészős mérés | `soborbo-tracking/lib/consent.ts` (`hasMarketingConsent`, `hasAnalyticsConsent`) | sbo alatt KIZÁRÓLAG az `sbo_consent` süti (policy-verzióval kapuzva); ismeretlen → tiltás |
| Döntés rögzítése | `src/routes/consent.ts` (`authorizeConsentWrite`) | igazolt (lánc-kulcs) írás bármit; igazolatlan írás csak szigoríthat |
| Szerveres fogadás (capture) | `src/routes/conversion.ts` → `lib/consent.ts resolveConsent` | a payload friss jele dönt (a consent_log sora ilyenkor még úton lehet); sbo alatt fail-closed, és CookieYes-forrású jel nem evidencia |
| CRM-esemény (offline Google) | `src/routes/lead-status.ts` → `decideAdConsent` | sbo: consent_log aktuális állapota, más nem; CookieYes: receipt → CRM `ad_allowed` → `require_consent` |
| Sorból feldolgozás (Queue) | `src/worker.ts queue()` → `retrySingle` → `checkReplayConsent` → `decideAdConsent` | mint fent, `passedCaptureGate`-tel; terminális skip → ack |
| Ütemezett újraküldés (cron) | `src/scheduled/retry.ts runRetry` → ugyanaz | terminális skip → `skipped` sor + a rekord törlése (visszavonásnál előtte `do_not_replay`) — UGYANAZ, mint a Queue-ágon |
| Kézi újraküldés (admin) | `src/routes/admin.ts` → `retrySingle` | ugyanaz a kapu |

## Valódi különbségek, amelyek megmaradnak

- **Kategória:** a GA4 (analitika) az `analytics_storage`-t, minden hirdetési
  csatorna az `ad_user_data`-t kérdezi. Csak-marketing engedély mellett a
  hirdetés mehet, a GA4 nem.
- **Capture vs. kézbesítés később:** a rögzítéskor a payload friss jele a
  bizonyíték; minden későbbi (offline, retry) döntésnél a consent_log AKTUÁLIS
  állapota — a nap-1 engedély / nap-3 visszavonás / nap-10 feltöltés így skippel.
- **CookieYes-site:** nincs consent_log és nincs visszavonás-forrás. Az
  újraküldésnél ott a capture-kori kapu döntése áll; a lead-olvasás hibája nem
  állítja meg a küldést (nincs mit elmulasztani).
- **Saját CMP (sbo):** a capture-kori receipt, a CRM `ad_allowed` jele és a
  CookieYes-süti NEM evidencia. Üzleti hatás: a webes döntés nélküli (pl.
  telefonos) leadek offline konverziója sbo-site-on nem töltődik fel.
