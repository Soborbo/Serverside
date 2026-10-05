# Romlandó tények

Verzió-, dátum- és limitfüggő állítások, forrással és az ellenőrzés dátumával.
Félévente felülvizsgálandó (következő: **2027-04**). Ha egy sor régebbi fél évnél,
ellenőrizd a forrást, mielőtt döntést építesz rá.

| Tény | Forrás | Ellenőrizve |
|---|---|---|
| Consent Mode v2 típusai: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`. | [Google: Set up consent mode](https://developers.google.com/tag-platform/security/guides/consent) (frissítve 2026-07-30) | 2026-10-05 |
| Sorrend: default → Google tag / GTM → CMP → update; „If your consent code is called out of order, consent defaults won't work.” | ugyanott | 2026-10-05 |
| `ads_data_redaction`: denied `ad_storage` mellett a Google Ads és Floodlight tagek kérésében a hirdetési kattintás-azonosítók kitakarva. | ugyanott | 2026-10-05 |
| `url_passthrough`: cookie nélkül URL-paraméterben viszi a kattintás-, client- és session-adatot a domainen belül. | ugyanott | 2026-10-05 |
| Basic: a tagek a banner-döntésig blokkolva, „No data is sent before a user consents”. Advanced: denied defaulttal betölt, cookieless pinget küld, hirdetőspecifikus modellezés. | [Google: Consent mode overview](https://developers.google.com/tag-platform/security/concepts/consent-mode) (frissítve 2026-07-30) | 2026-10-05 |
| A Google Ads API `UploadClickConversions` 2026-06-15 óta hibát ad, ha a fejlesztőtoken korábban nem töltött fel offline / EC for Leads konverziót; helyette Data Manager API. | [Google Ads API: Upload offline conversions](https://developers.google.com/google-ads/api/docs/conversions/upload-offline) | 2026-10-05 |
| Data Manager API: `POST https://datamanager.googleapis.com/v1/events:ingest`, scope `https://www.googleapis.com/auth/datamanager`, `validateOnly`, legfeljebb 2000 esemény kérésenként, ad identifiers: `gclid`, `gbraid`, `wbraid`. | [Data Manager API: events.ingest](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) (frissítve 2026-09-10) | 2026-10-05 |
| Meta dedup: Pixel `eventID` = CAPI `event_id` **és** Pixel `event` = CAPI `event_name`, ugyanarra a pixelre, 48 órán belül. | [Meta: Deduplicate Pixel and Server Events](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/) | 2026-10-02 |
| fbc formátum `fb.<subdomainIndex>.<ms>.<fbclid>`, az fbclid változatlan kis/nagybetűvel, nem hashelve. | [Meta: fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/) | 2026-10-02 |
| CookieYes `getCkyConsent()`: `categories` kulcsai `necessary`, `functional`, `analytics`, `performance`, `advertisement`; további mezők `isUserActionCompleted`, `consentID`, `activeLaw`. Események: `cookieyes_banner_load`, `cookieyes_consent_update`. | [CookieYes: getCkyConsent](https://www.cookieyes.com/documentation/retrieving-consent-data-using-api-getckyconsent/), [CookieYes: banner events](https://www.cookieyes.com/documentation/events-on-cookie-banner-load/) | 2026-10-02 |
| Clarity: 2025-10-31 óta EGT / UK / CH látogatóknál consent-jel kell a teljes működéshez. API: `clarity('consentv2', { ad_Storage, analytics_Storage })`, kis/nagybetű-érzékeny; a régi `clarity('consent')` kivezetés alatt. Consent nélkül oldalnézetenként új azonosító, süti nincs. | [Microsoft Learn: Clarity Consent API v2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) (frissítve 2025-12-05) | 2026-10-05 |
| Clarity custom tag: `clarity('set', key, value)`, a value string vagy string-tömb, a tagek száma nincs korlátozva. Projektenként napi 100 000 felvétel, fölötte mintavétel. | [Microsoft Learn: Clarity client API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api) (frissítve 2025-12-05) | 2026-10-05 |
| WebKit ITP: minden JS-ből írt süti és szkriptből írható tároló (localStorage, sessionStorage, IndexedDB …) törlődik 7 nap interakció nélküli Safari-használat után; link-dekorált érkezésnél a JS-sütik élettartama 24 óra. | [WebKit: Tracking Prevention Policy](https://webkit.org/tracking-prevention/) | 2026-10-05 |
| Safari Link Tracking Protection: privát módban, Mailben és Messagesben eltávolítja a gclid/fbclid/msclkid paramétert. | [taggrs.io: Safari 26 tracking changes](https://taggrs.io/safari-26-tracking-changes/) (másodlagos forrás) | 2026-10-02 |
| GA4 ajánlott lead-események: `generate_lead`, `working_lead`, `qualify_lead`, `disqualify_lead`, `close_convert_lead`, `close_unconvert_lead`. | [GA4: Recommended events](https://support.google.com/analytics/answer/9267735) | 2026-10-02 (csak keresési találat) |

## Belső, de romlandó állapot

| Tény | Hol nézd meg | Ellenőrizve |
|---|---|---|
| sbo CMP: Befilo (thebespokejoinery.co.uk) 2026-09-17 óta élő KV-ban; nonmono.hu és nonmono.org site-inputja sbo-val (PR #136); a lead-gen site-ok CookieYes-en. | `soborbo-tracking/server/site-inputs/`, élő KV `consent.provider` | 2026-10-05 |
| A `Tracking.astro` sorrend-javítása, az `ads_data_redaction` és a gbraid/wbraid rejtett mező a PR #137-ben (6.9.1). | `gh pr view 137` | 2026-10-05 |
| Consent-szöveg verziók: `2026-08-a`, `2026-09-a`. | `soborbo-tracking/consent-texts/` | 2026-10-05 |

Frissítéshez a Google Consent Mode leírása Context7-ben:
`/websites/developers_google_tag-platform_security_guides`.
