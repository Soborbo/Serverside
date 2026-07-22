/**
 * F4-1 · Site-manifest drift-check.
 *
 * A `site-manifest.json` a repóban a SINGLE SOURCE OF TRUTH arról, MILYEN
 * (nem-titkos) alakúnak KELL lennie minden élő KV site-confignak. A napi digest
 * ezt veti össze a LIVE KV-vel: ha egy config eltér (pl. a meta-blokk eltűnik — a
 * 2026-07-14-i lomtalan-osztályú néma kiesés), az másnap CRITICAL sorként jelenik
 * meg, nem hetekkel később egy elveszett bevétel formájában.
 *
 * SECRET-BIZTONSÁG: a manifest CSAK fingerprintet (sha256 hex) tárol, nyers configot
 * SOHA. A fingerprint bemenetében a titkos mezők (`meta.access_token`,
 * `ga4.api_secret`) a saját sha256-jukkal helyettesítődnek — így egy token-rotáció
 * DRIFT-ként detektálódik anélkül, hogy a plaintext a gitbe kerülne. A már eleve
 * hash-elt mezők (`crm_token_sha256`) változatlanul mennek. A `test_event_code`-ot
 * SZÁNDÉKOSAN nem redaktáljuk: ha egy prod-configba beszivárog (CLAUDE.md §17), a
 * fingerprint megváltozik → drift-riasztás, pont ahogy kell.
 */

import { sha256Hex } from './hash';

/** Egy site-config fingerprintje: sha256:<hex>. */
export type SiteFingerprint = string;

/** hostname → fingerprint. Ez a `src/site-manifest.json` alakja. */
export interface SiteManifest {
  /** Provenance (informatív; NEM a fingerprint bemenete). */
  generated_at?: string;
  source_commit?: string;
  /** hostname → sha256:<hex> fingerprint. */
  sites: Record<string, SiteFingerprint>;
}

/**
 * Rekurzív kulcs-rendezés + kompakt szerializálás — determinisztikus kanonikus
 * alak, hogy a mezők SORRENDJE ne befolyásolja a fingerprintet (csak a TARTALOM).
 * A generátor (.mjs) ezt a függvényt BÁJTPONTOSAN tükrözi; a paritást a
 * site-manifest.test.ts őrzi.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(',')}}`;
}

/**
 * Titkos mezők helyettesítése a saját sha256-jukkal (secret-safe fingerprint-bemenet).
 * Mély másolatot ad vissza; az eredetit nem módosítja.
 */
export async function redactSecrets(config: unknown): Promise<unknown> {
  if (config === null || typeof config !== 'object') return config;
  const c = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const meta = c.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta.access_token === 'string' && meta.access_token) {
    meta.access_token = `sha256:${await sha256Hex(meta.access_token)}`;
  }
  const ga4 = c.ga4 as Record<string, unknown> | undefined;
  if (ga4 && typeof ga4.api_secret === 'string' && ga4.api_secret) {
    ga4.api_secret = `sha256:${await sha256Hex(ga4.api_secret)}`;
  }
  return c;
}

/** Egy KV site-config secret-safe fingerprintje. */
export async function fingerprintConfig(config: unknown): Promise<SiteFingerprint> {
  const redacted = await redactSecrets(config);
  return `sha256:${await sha256Hex(canonicalize(redacted))}`;
}

export type DriftKind =
  /** A manifestben van, de a LIVE KV-ből hiányzik (config eltűnt). */
  | 'missing'
  /** A LIVE KV fingerprintje eltér a manifesttől (config megváltozott). */
  | 'changed'
  /** A LIVE KV-ben van, de a manifestből hiányzik (új site, még nincs manifesztálva). */
  | 'unmanifested';

export interface DriftEntry {
  hostname: string;
  kind: DriftKind;
}

/**
 * A manifest és a LIVE fingerprintek összevetése. Tiszta függvény (a KV-olvasás a
 * hívóé), hogy egységtesztelhető legyen.
 *
 * `missing` és `changed` = valódi drift (a source-of-truth és a production
 * széttartott) → CRITICAL. `unmanifested` = új site, amit még nem vettek fel a
 * manifestbe → WARNING (nem hiba, de tennivaló: futtasd a generátort).
 */
export function diffManifest(
  manifest: SiteManifest,
  liveFingerprints: Map<string, SiteFingerprint>
): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const expected = manifest.sites ?? {};
  for (const [hostname, fp] of Object.entries(expected)) {
    const live = liveFingerprints.get(hostname);
    if (live === undefined) drift.push({ hostname, kind: 'missing' });
    else if (live !== fp) drift.push({ hostname, kind: 'changed' });
  }
  for (const hostname of liveFingerprints.keys()) {
    if (!(hostname in expected)) drift.push({ hostname, kind: 'unmanifested' });
  }
  drift.sort((a, b) => a.hostname.localeCompare(b.hostname));
  return drift;
}
