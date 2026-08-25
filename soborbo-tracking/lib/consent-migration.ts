/**
 * P3.1 — `legacyConsentMigrationPolicy`: MI TÖRTÉNIK a CookieYes-korszak
 * hozzájárulásaival, amikor egy site átáll a saját CMP-re.
 *
 * A DÖNTÉS: **`reconsent_all`**. A flip után minden látogató ÚJRA kap bannert;
 * a korábbi CookieYes-döntést SEMMILYEN formában nem vesszük át.
 *
 * MIÉRT NEM MIGRÁLUNK — a bizonyítás, nem a kényelem
 * ────────────────────────────────────────────────────────────────────────────
 * A brief szabálya: „ha nem bizonyítható az ekvivalencia → reconsent_all".
 * Négy független ok, amiért nem bizonyítható:
 *
 * 1. KATEGÓRIA-TAXONÓMIA ELTÉRÉS. A CookieYes öt kategóriát mutat (necessary,
 *    functional, analytics, performance, advertisement); a saját panelünk
 *    hármat (necessary, analytics, marketing). Egy látogató, aki a CookieYes-ben
 *    `analytics: yes` + `performance: no` kombinációt adott, NEM képezhető le
 *    egyértelműen — a mi `analytics` kategóriánk mindkettőt lefedi.
 *
 * 2. NINCS MEG A BIZONYÍTÉK-LÁB. A `consent_log` a GDPR Art. 7(1) miatt NÉGY
 *    verziómezőt követel: `policy_version`, `banner_version`,
 *    `consent_text_version`, `client_lib_version`. Egy CookieYes-döntéshez
 *    ezekből EGY SINCS meg. Egy migrált sor tehát nem tudná megmondani, MIT
 *    olvasott az illető — vagyis pont az a bizonyíték hiányozna, amiért a
 *    napló létezik.
 *
 * 3. AMIT A CookieYes SÜTIJÉBŐL EGYÁLTALÁN LÁTUNK, AZ KÉT BOOLEAN.
 *    A `readCkyParallelWindow()` az `analytics` és az `advertisement`
 *    kulcsot olvassa ki — nincs benne időbélyeg, nincs consent-azonosító,
 *    nincs szövegverzió. Egy „mikor és mire mondott igent" kérdésre a süti nem
 *    válaszol.
 *
 * 4. AZ EKVIVALENCIA NEM IS AUDITÁLHATÓ. A 2026-08-25-i ellenőrzéskor a
 *    csatlakoztatott CookieYes-fiókban a flotta nyolc domainjéből EGY szerepelt.
 *    A többi site banner-szövegét és kategória-leírásait API-ból nem tudjuk
 *    kiolvasni, tehát a „ugyanazt a célt írta le" állítás nem ellenőrizhető.
 *
 * MI AZ ÁRA, ÉS MIÉRT VÁLLALJUK. A visszatérő látogatók a flip napján ismét
 * bannert kapnak, és amíg nem döntenek, `unknown` állapotban vannak → a
 * marketing-jelek denied-ek. Ez átmeneti attribúció- és konverzió-visszaesést
 * okoz, amit a rollout-ablakban ELŐRE mérni kell (baseline-snapshot). Az
 * alternatíva viszont az lenne, hogy egy nem bizonyítható jogalapra építve
 * küldünk tovább hirdetési adatot — ami pontosan az a fajta néma kockázat,
 * amit ez a rendszer mindenhol máshol is elutasít.
 *
 * IMPLICIT SÜTI-MÁSOLÁS TILOS. A `readCkyParallelWindow()` kimenete KIZÁRÓLAG
 * a wire-payload `cky_cookie_analytics` / `cky_cookie_marketing` TELEMETRIA-
 * mezőibe kerül (a párhuzamos mérési ablak diagnosztikája) — soha nem lesz
 * belőle `sbo_consent` süti. A `tests/consent-migration.test.ts` ezt
 * viselkedésben ÉS statikus vizsgálattal is kikényszeríti.
 */

export type LegacyConsentMigrationPolicy = 'reconsent_all' | 'migrate_if_equivalent';

/**
 * A HATÁLYOS politika. Megváltoztatásához az ekvivalencia BIZONYÍTÁSA kell
 * (kategória-leképezés, szövegverzió-egyezés, időbélyeg-forrás), nem egy
 * egysoros szerkesztés — a `consent-migration.test.ts` ezt a konstanst is őrzi.
 */
export const LEGACY_CONSENT_MIGRATION_POLICY: LegacyConsentMigrationPolicy = 'reconsent_all';

/**
 * Van-e egyáltalán olyan üzemmód, amelyben egy korábbi (nem sbo) döntésből
 * érvényes sbo-állapotot vezetünk le? Ma nincs — és a hívóknak ezt a
 * függvényt kell kérdezniük, nem a konstanst közvetlenül összehasonlítaniuk,
 * hogy egy jövőbeli politika-változás EGY helyen legyen bekötve.
 */
export function mayDeriveConsentFromLegacyCmp(): boolean {
  return LEGACY_CONSENT_MIGRATION_POLICY === 'migrate_if_equivalent';
}
