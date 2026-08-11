import type { TrackingErrorCode } from './lib/error-codes';
import eventsJson from './events.json';

export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  error_code?: TrackingErrorCode | string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  status?: number;
  [key: string]: unknown;
};

export function logStructured(log: StructuredLog): void {
  const fn =
    log.level === 'error' ? console.error : log.level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(log));
}

export interface PlainUserDataPayload {
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  // Stabil, alkalmazás/CRM/cookie-szintű azonosító. Meta CAPI external_id-ként
  // megy (hash-elve) → javítja az Event Match Quality-t és dedup-fallback.
  external_id?: string;
}

// F3-A/2 · Prehashed PII contract (SZERVER-INGRESS-ONLY). A CRM outbox már-hash-elt
// user_data-t küld, hogy a gateway NE hash-eljen újra (dupla hash → néma match-rate
// esés). Minden mező 64-hosszú lowercase hex SHA-256; a `user_data`-val KÖLCSÖNÖSEN
// KIZÁRÓ. A gateway a böngésző-ágon eldobja (mint a client_ip / test_event_code) —
// különben egy böngésző áldozat hash-elt identitására lőhetne konverziót plaintext
// nélkül. A hash-mezők a HashedUserData em/ph/fn/ln/ct/zp/country/external_id-re map-elnek.
export interface HashedUserDataPayload {
  sha256_email?: string;
  sha256_phone?: string;
  sha256_first_name?: string;
  sha256_last_name?: string;
  sha256_city?: string;
  sha256_postal_code?: string;
  sha256_country?: string;
  sha256_external_id?: string;
}

export interface ConversionRequestPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  // Böngésző-ágon kötelező (a Turnstile-kapu enélkül 403-at ad low-risk eventen
  // kívül). Szerver-szerver ingressen (X-Admin-Token) NINCS böngésző, tehát nincs
  // token sem → a mező opcionális. A kapu maga változatlan: token nélkül csak a
  // hitelesített szerver-hívás VAGY a degradált low-risk ág jut át.
  turnstile_token?: string;

  // CSAK szerver-szerver ingressen (hitelesített hívó) veendő figyelembe: a VALÓDI
  // végfelhasználó IP-je / User-Agentje. A hívó szerver a saját request-headereiből
  // olvassa ki és továbbítja, különben a Meta a hívó Worker IP/UA-ját látná (rossz
  // geo, romló EMQ). Böngésző-ágon a request-header az igazságforrás, és ezeket a
  // mezőket SZÁNDÉKOSAN eldobjuk — különben bárki spoofolhatná az IP-t.
  client_ip_address?: string;
  client_user_agent?: string;

  // CSAK szerver-szerver ingressen (hitelesített hívó) veendő figyelembe. Egy
  // szintetikus proof-eventet ezzel lehet GARANTÁLTAN a Meta Test stream-jébe
  // küldeni, a KV site-config PISZKÁLÁSA NÉLKÜL.
  //
  // Miért nem elég a KV `meta.test_event_code`: a site-config edge-cache-elt
  // (cacheTtl=300s, lib/config.ts). A „KV-be beírom → azonnal lövök" mintában a
  // teszt-event könnyen egy MÉG RÉGI configot látó PoP-ra fut, és a PRODUCTION
  // stream-be kerül — pontosan ez szivárogtatott 2 szintetikus eventet a Painless
  // prod-ba. Fordítva ugyanez: a kivétel után még ~5 percig VALÓDI leadek
  // mehetnek a Test stream-be (CLAUDE.md 17 csendes hibája).
  // A per-request override mindkét ablakot megszünteti: determinisztikus, és
  // élő configot nem kell módosítani. Böngésző-ágon SZÁNDÉKOSAN eldobjuk.
  test_event_code?: string;

  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  event_source_url?: string;
  user_data?: PlainUserDataPayload;
  // F3-A/2 prehashed PII contract (server-ingress only). Kölcsönösen kizáró a
  // `user_data`-val; a gateway NEM hash-eli újra. Lásd HashedUserDataPayload.
  user_data_hashed?: HashedUserDataPayload;
  fbp?: string;
  fbc?: string;
  client_id?: string;
  // Stabil lead-azonosító (UUID, NEM PII). A kliens generálja és ezzel köti
  // össze a konverziót a későbbi CRM offline-loop státuszokkal (lead_qualified,
  // booking_confirmed, revenue_confirmed). Opcionális; hiányában a ledger
  // rögzíti az eventet, de a CRM-loop nem tud rákötni.
  lead_id?: string;
  // GA4 session azonosító a `_ga_<container>` cookie-ból (GS1.1.<session_id>...).
  // Nélküle az MP-event elfogadódik, de nem jelenik meg rendesen a riportokban.
  session_id?: string;
  // Google Consent Mode v2 jelek (ad_user_data, ad_personalization, ad_storage,
  // analytics_storage). Lásd lib/consent.ts.
  consent?: unknown;
  // Univerzális attribúció: click ID-k (gclid/gbraid/wbraid/fbclid/...) + UTM-ek
  // + kontextus. Lásd lib/attribution.ts.
  attribution?: unknown;
  // §3 automatikus lead-útvonal: cold | post_quote | from_quote_email. Ingress-
  // validált (lib/provenance.ts); érvénytelen → drop (TRK-PROV-001). Meta
  // custom_data paraméterként utazik (nem PII).
  lead_provenance?: string;
  // ── E-kereskedelmi katalógus-mezők (webshop tenantok) ─────────────────────
  // A Meta custom_data-ba mennek. Lead-gen site-okon egyszerűen hiányoznak.
  // NEM PII. Érvénytelen forma → a route ELDOBJA a mezőt, az event megy tovább
  // (ugyanaz a szabály, mint a lead_id-nál: egy katalógus-formahiba nem nyelheti
  // el magát a purchase konverziót).
  //
  // A `contents` a Meta ajánlott formája (id + quantity + item_price); a
  // `content_ids` a lapos fallback. Együtt is küldhetők — a Meta a `contents`-t
  // részesíti előnyben. Az id-knak a katalógus `retailer_id`-jével KELL egyezniük,
  // különben a dinamikus remarketing nem talál rá a termékre.
  contents?: unknown;
  content_ids?: unknown;
  content_type?: unknown;
  num_items?: unknown;
  // A shop rendelésazonosítója — a Meta ezzel szűri a duplikált purchase-t a
  // saját oldalán, és ez a join-kulcs a shop rendelés-riportjai felé.
  order_id?: unknown;

  [key: string]: unknown;
}

// ── Kanonikus event-forrás (events.json) ────────────────────────────────────
// EGYETLEN igazságforrás (§1). Az ALLOWED_EVENT_NAMES, az EVENT_NAME_MAP és a
// legacy→kanonikus alias-térkép MIND ebből származik runtime-ban — nincs kézi
// lista, így drift sem lehet. Új event = egy bejegyzés events.json-ban.

export interface CanonicalEvent {
  name: string;
  kind: 'conversion' | 'engagement' | 'ecommerce' | 'offline';
  module: string;
  ga4_key_event: boolean;
  meta: string | null;
  channels: Array<'browser' | 'server'>;
  // true → az eventet a gateway CSAK a hitelesített /api/event/conversion-server
  // ingressen fogadja (per-site token). A böngésző-út (Origin-gate) 403-at ad rá:
  // az Origin curl-ből hamisítható, és e nélkül bárki hamis lead/purchase
  // konverziót lőhetne tetszőleges hash-elt PII-vel. A böngésző-Pixel továbbra
  // is tüzel ugyanazzal az event_id-vel → Pixel/CAPI dedup ép marad.
  server_ingress_only?: boolean;
  provenance: boolean;
  flow: 'A' | 'B' | null;
  legacy_ga4: string | null;
  legacy_datalayer: string | null;
  description: string;
}

export const CANONICAL_EVENTS = eventsJson as unknown as CanonicalEvent[];

// A /api/event/conversion ingress által elfogadott nevek: server-csatornás, NEM
// offline eventek (az offline a /api/event/lead-status admin-route-on érkezik),
// PLUSZ a legacy_ga4 aliasok (migrációs elfogadás — canonicalizeEventName normalizál).
// A unknown event_name elutasítása megakadályozza az Analytics Engine cardinality
// robbanást támadó-vezérelt stringekkel.
const _ingressEvents = CANONICAL_EVENTS.filter(
  (e) => e.channels.includes('server') && e.kind !== 'offline'
);
export const ALLOWED_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  ..._ingressEvents.map((e) => e.name),
  ..._ingressEvents.map((e) => e.legacy_ga4).filter((n): n is string => n !== null)
]);

// High-value (hamisítható) konverziók — CSAK a hitelesített szerver-ingress
// fogadja őket; a böngésző-út 403-at ad. KANONIKUS neveket tartalmaz: a route
// az ellenőrzés ELŐTT canonicalizeEventName-el normalizál, így a legacy aliasok
// (pl. quote_calculator_conversion) sem kerülik meg a kaput.
export const SERVER_INGRESS_ONLY_EVENTS: ReadonlySet<string> = new Set<string>(
  CANONICAL_EVENTS.filter((e) => e.server_ingress_only === true).map((e) => e.name)
);

// legacy GA4 alias → kanonikus név. Ingress-belépéskor normalizálunk, hogy minden
// downstream (Meta-map, ledger, forwarderek, special-case logika) EGYSÉGESEN a
// kanonikus nevet lássa, miközben a régi kliensek/tesztek se törjenek.
const _legacyToCanonical = new Map<string, string>();
for (const e of CANONICAL_EVENTS) {
  if (e.legacy_ga4) _legacyToCanonical.set(e.legacy_ga4, e.name);
}
export function canonicalizeEventName(name: string): string {
  return _legacyToCanonical.get(name) ?? name;
}

// Belső event_name (kanonikus ÉS legacy alias) → Meta standard event név. Minden
// meta!=null eventből generálva (a browser-only ViewContent-mérföldkövek is, mert
// a szerver-oldali derived ViewContent rájuk map-el). A korábbi kézi térkép a
// lib/meta.ts-ben élt; most innen, az events.json-ból származik (§1.2).
export const EVENT_NAME_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of CANONICAL_EVENTS) {
    if (e.meta) {
      m[e.name] = e.meta;
      if (e.legacy_ga4) m[e.legacy_ga4] = e.meta;
    }
  }
  return m;
})();

// Meta CAPI event_id cap (CLAUDE.md #2/#16). A valós id egy 36 karakteres UUID.
// (A derived ViewContent is a quote event_id-jét használja suffix nélkül — a Meta
// az (event_name, event_id) PÁRON dedup-ol, így ez a böngésző-pixellel egyezik.)
const MAX_EVENT_ID_LENGTH = 40;
const MIN_EVENT_TIME = 1_500_000_000; // 2017-07-14
const MAX_VALUE = 1_000_000_000;

export function isValidConversionPayload(payload: unknown): payload is ConversionRequestPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.event_name !== 'string' || !ALLOWED_EVENT_NAMES.has(p.event_name)) return false;
  if (
    typeof p.event_id !== 'string' ||
    p.event_id.length === 0 ||
    p.event_id.length > MAX_EVENT_ID_LENGTH ||
    !/^[a-zA-Z0-9_-]+$/.test(p.event_id)
  ) {
    return false;
  }
  if (
    typeof p.event_time !== 'number' ||
    !Number.isFinite(p.event_time) ||
    p.event_time < MIN_EVENT_TIME ||
    p.event_time > Math.floor(Date.now() / 1000) + 600
  ) {
    return false;
  }
  // turnstile_token: opcionális (szerver-szerver ingress nem küld), de ha jelen
  // van, stringnek KELL lennie. A hiánya NEM jelent elfogadást — a route
  // Turnstile-kapuja dönt (403, hacsak nem hitelesített szerver-hívás vagy
  // degradált low-risk event).
  if (p.turnstile_token !== undefined && typeof p.turnstile_token !== 'string') return false;
  // client_ip_address / client_user_agent: csak szerver-ingressen érvényesül (a
  // route dobja el böngésző-ágon). Itt csak strukturális + hossz-korlát, hogy egy
  // óriás UA-string ne fusson be a Meta-payloadba.
  if (
    p.client_ip_address !== undefined &&
    (typeof p.client_ip_address !== 'string' || p.client_ip_address.length > 45)
  ) {
    return false;
  }
  if (
    p.client_user_agent !== undefined &&
    (typeof p.client_user_agent !== 'string' || p.client_user_agent.length > 512)
  ) {
    return false;
  }
  // test_event_code: csak szerver-ingressen érvényesül (a route dobja el böngésző-
  // ágon). Meta-formátum: rövid alfanumerikus (pl. TEST12345).
  if (
    p.test_event_code !== undefined &&
    (typeof p.test_event_code !== 'string' ||
      p.test_event_code.length === 0 ||
      p.test_event_code.length > 40 ||
      !/^[A-Za-z0-9_-]+$/.test(p.test_event_code))
  ) {
    return false;
  }
  if (
    p.value !== undefined &&
    (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0 || p.value > MAX_VALUE)
  ) {
    return false;
  }
  // lead_id: SZÁNDÉKOSAN nem itt validáljuk. A lead_id opcionális metaadat — ha
  // érvénytelen (rossz charset/hossz, pl. egy CRM rövid numerikus id-t ad), a
  // route ELDOBJA a mezőt (warn) és az event MEGY tovább. Itt elutasítani azt
  // jelentené, hogy egy join-kulcs formátumhibája a pénzt jelentő konverziót
  // magát nyeli el 204-gyel (lásd Run 6 audit). Charset-őr: isValidLeadId
  // (lib/ledger.ts) a route-ban.
  // user_data_hashed: ha jelen van, objektum KELL legyen (strukturális őr). A
  // per-mező 64-hex validáció és a user_data-val való kölcsönös kizárás a route-ban
  // van (TRK-400-018/019), hogy a hitelesített CRM-hívó KONKRÉT 400-at kapjon (retry).
  if (
    p.user_data_hashed !== undefined &&
    (typeof p.user_data_hashed !== 'object' || p.user_data_hashed === null || Array.isArray(p.user_data_hashed))
  ) {
    return false;
  }
  return true;
}
