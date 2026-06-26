import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { logStructured } from '../types';
import { TrackingErrorCode } from './error-codes';

/**
 * Microsoft Advertising offline conversions forwarder (TASK 3) — msclkid alapú.
 *
 * SCAFFOLD ONLY. A Microsoft Ads offline-konverzió feltöltés (ApplyOfflineConversions)
 * a Bing Ads Campaign Management API-n megy, ami SOAP + OAuth (developer token +
 * refresh token, a Google Ads-hez hasonló flow) — NEM egy egyszerű REST/JSON
 * endpoint, mint a TikTok/LinkedIn. Mivel nincs hitelesítő, a LIVE TRANSPORT
 * SZÁNDÉKOSAN NINCS IMPLEMENTÁLVA (nem küldünk hamis hívást).
 *
 * Ez a modul felépíti a kanonikus offline-conversion rekordot és a fan-out-ba
 * van kötve (consent-gated, DLQ-durable), de a tényleges kiküldés helyén TODO áll.
 * Config nélkül no-op skip.
 *
 * TODO(live): implementáld a Bing Ads ApplyOfflineConversions transportot:
 *   - OAuth: developer token (env) + customer refresh/access token (OAUTH_TOKENS KV),
 *   - SOAP envelope a CampaignManagementService-hez VAGY a Bing Ads REST bridge,
 *   - OfflineConversion: { MicrosoftClickId, ConversionName, ConversionTime(UTC),
 *     ConversionValue, ConversionCurrencyCode }.
 *   Élesítés előtt verifikáld a Microsoft Ads UI offline-conversion riportjában.
 */

export interface MsAdsPayload {
  event_name: string;
  event_time: number; // unix seconds
  value?: number;
  currency?: string;
  msclkid?: string;
}

export interface MsAdsResult {
  success: boolean;
  error?: string;
  error_code?: TrackingErrorCode;
  status?: number;
  scaffolded?: boolean; // true = a rekord felépült, de a live transport TODO
  skipped?: boolean; // ledger: ne számítson valódi kézbesítésnek
}

/** A kanonikus offline-conversion rekord (a live transport ezt küldené). */
export interface MsAdsOfflineConversion {
  microsoftClickId: string;
  conversionName: string;
  conversionTime: string; // ISO 8601 UTC
  conversionValue?: number;
  conversionCurrencyCode?: string;
}

/** Pure: felépíti az offline-conversion rekordot (tesztelhető). null, ha nincs msclkid/név. */
export function buildOfflineConversion(
  siteConfig: SiteConfig,
  payload: MsAdsPayload
): MsAdsOfflineConversion | null {
  const cfg = siteConfig.msads;
  const conversionName = cfg?.conversion_names?.[payload.event_name];
  if (!cfg || !conversionName || !payload.msclkid) return null;
  const rec: MsAdsOfflineConversion = {
    microsoftClickId: payload.msclkid,
    conversionName,
    conversionTime: new Date(payload.event_time * 1000).toISOString()
  };
  if (typeof payload.value === 'number' && payload.value > 0) {
    rec.conversionValue = payload.value;
    if (payload.currency) rec.conversionCurrencyCode = payload.currency;
  }
  return rec;
}

export async function sendToMsAds(
  siteConfig: SiteConfig,
  payload: MsAdsPayload,
  _hashedUserData: HashedUserData
): Promise<MsAdsResult> {
  const conversion = buildOfflineConversion(siteConfig, payload);
  if (!conversion) {
    return { success: true, skipped: true }; // nem konfigurált / nincs msclkid → no-op skip
  }

  // TODO(live): itt menne a Bing Ads ApplyOfflineConversions kiküldés (lásd a
  // fájl fejléc TODO-ját). Addig: felépített rekord, skip-success, hogy a fan-out
  // ne blokkoljon és a DLQ-t ne szennyezzük hamis hibákkal.
  logStructured({
    level: 'info',
    message: 'Microsoft Ads offline conversion built (live transport TODO — not sent)',
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    conversion_name: conversion.conversionName
  });
  // skipped:true — amíg a live transport TODO, ne számítson valódi kézbesítésnek.
  return { success: true, scaffolded: true, skipped: true };
}
