/**
 * Oldal-kontextusba injektált MŰSZER (Playwright `addInitScript`) — MINDEN
 * oldal-szkript ELŐTT fut, tehát a legelső tag-betöltést is látja.
 *
 * Mit rögzít:
 *  - localStorage / sessionStorage getItem+setItem+removeItem (OLVASÁS is: a PECR
 *    alatt a tárolt adathoz való hozzáférés is engedélyköteles, nem csak az írás),
 *  - `document.cookie` olvasás és írás,
 *  - `dataLayer.push` hívások időbélyeggel (a `consent default` sorrendjéhez),
 *  - `navigator.sendBeacon` hívások.
 *
 * ÉS AMIT MEGAKADÁLYOZ (a harness nem cselekszik, csak megfigyel):
 *  - minden űrlap-beküldés (`submit()` és a submit-esemény is), hogy élő oldalon
 *    SOHA ne keletkezzen hamis lead. Ez a második védvonal; az első a hálózati
 *    szinten abortált first-party POST (lásd run.mjs `installSafetyNet`).
 *
 * A függvény forrása stringként megy át a böngészőbe — ne használj benne
 * Node-specifikus dolgot, és ne hivatkozz külső változóra.
 */
export function instrumentationScript() {
  // eslint-disable-next-line func-names
  return function () {
    const rec = {
      storage: [],
      cookieReads: 0,
      cookieWrites: [],
      dataLayer: [],
      beacons: [],
      blockedSubmits: [],
      startedAt: Date.now()
    };
    Object.defineProperty(window, '__compliance', { value: rec, configurable: true });

    const now = () => Date.now();

    // ── Storage (localStorage ÉS sessionStorage — közös prototípus) ──────────
    try {
      const proto = Storage.prototype;
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const native = proto[method];
        proto[method] = function (key, value) {
          let area = 'unknown';
          try {
            area = this === window.localStorage ? 'local' : this === window.sessionStorage ? 'session' : 'unknown';
          } catch (e) { /* cross-origin / disabled storage */ }
          rec.storage.push({ t: now(), op: method, area, key: String(key) });
          return native.call(this, key, value);
        };
      }
    } catch (e) { /* storage disabled */ }

    // ── document.cookie ──────────────────────────────────────────────────────
    try {
      const desc =
        Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
        Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
      if (desc && desc.get && desc.set) {
        Object.defineProperty(document, 'cookie', {
          configurable: true,
          get() {
            rec.cookieReads++;
            return desc.get.call(document);
          },
          set(v) {
            rec.cookieWrites.push({ t: now(), name: String(v).split('=')[0].trim() });
            return desc.set.call(document, v);
          }
        });
      }
    } catch (e) { /* */ }

    // ── dataLayer ────────────────────────────────────────────────────────────
    // A tömb létrejöhet ELŐTTÜNK (inline snippet) vagy UTÁNUNK (GTM loader), ezért
    // a property setterét is elkapjuk. A push argumentumait sekélyen szerializáljuk:
    // a `gtag('consent','default',{...})` az arguments-objektumot tolja be.
    try {
      const shallow = (a) => {
        try {
          return JSON.parse(JSON.stringify(Array.prototype.slice.call(a))).slice(0, 4);
        } catch (e) {
          return ['<unserializable>'];
        }
      };
      const wrap = (arr) => {
        if (!arr || arr.__complianceWrapped) return arr;
        for (const existing of arr) rec.dataLayer.push({ t: now(), pre: true, args: shallow([existing]) });
        const nativePush = arr.push.bind(arr);
        arr.push = function () {
          rec.dataLayer.push({ t: now(), pre: false, args: shallow(arguments) });
          return nativePush.apply(null, arguments);
        };
        try {
          Object.defineProperty(arr, '__complianceWrapped', { value: true });
        } catch (e) { /* */ }
        return arr;
      };
      let dl = window.dataLayer;
      Object.defineProperty(window, 'dataLayer', {
        configurable: true,
        get() { return dl; },
        set(v) { dl = wrap(v); }
      });
      if (dl) wrap(dl);
    } catch (e) { /* */ }

    // ── sendBeacon ───────────────────────────────────────────────────────────
    try {
      const nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      if (nativeBeacon) {
        navigator.sendBeacon = function (url, data) {
          rec.beacons.push({ t: now(), url: String(url) });
          return nativeBeacon(url, data);
        };
      }
    } catch (e) { /* */ }

    // ── ŰRLAP-BEKÜLDÉS BLOKKOLÁSA (nulla hamis lead) ─────────────────────────
    try {
      const nativeSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        rec.blockedSubmits.push({ t: now(), how: 'form.submit()', action: String(this.action || '') });
        // SZÁNDÉKOSAN nem hívjuk a natívot.
        return undefined;
      };
      // A natív referenciát megtartjuk, hogy a patch felismerhető legyen, de sosem hívjuk.
      HTMLFormElement.prototype.submit.__native = nativeSubmit;
      window.addEventListener(
        'submit',
        (e) => {
          rec.blockedSubmits.push({
            t: now(),
            how: 'submit event',
            action: String((e.target && e.target.action) || '')
          });
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        true
      );
    } catch (e) { /* */ }
  };
}

/** A nem-esszenciális (mérési/marketing) storage-kulcsok mintái. */
export const NON_ESSENTIAL_STORAGE_PATTERNS = [
  /^sb_tracking$/,
  /^sb_first_touch$/,
  /^sb_session$/,
  /^__sb_attribution$/,
  /^_ga/,
  /^_gid/,
  /^_fb/,
  /^_hj/i,
  /^ajs_/,
  /^amplitude/i,
  /^mp_/,
  /^__utm/,
  /clarity/i,
  /hubspot/i,
  /^_uet/i
];

export function isNonEssentialStorageKey(key) {
  return NON_ESSENTIAL_STORAGE_PATTERNS.some((re) => re.test(key));
}

/**
 * Nem-esszenciális SÜTIK. A CookieYes saját `cookieyes-consent` sütije és a
 * szerver session-sütik esszenciálisak — azok jelenléte nem szabálysértés.
 */
export const ESSENTIAL_COOKIE_PATTERNS = [
  /^cookieyes/i,
  /^cky/i,
  /^__cf/i,
  /^cf_/i,
  /^PHPSESSID$/i,
  /^astro/i,
  /^session/i,
  /^csrf/i,
  /^XSRF/i
];

export function isNonEssentialCookie(name) {
  return !ESSENTIAL_COOKIE_PATTERNS.some((re) => re.test(name));
}
