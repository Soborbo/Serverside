import { describe, it, expect } from 'vitest';
// Importing the JSON proves it parses (resolveJsonModule) and runs in jsdom
// without node:fs. It must also cover the canonical browser side.
import container from '../gtm/container.json';

describe('gtm/container.json — importable export', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = container as any;
  const cv = c.containerVersion;

  it('has the GTM export schema shape', () => {
    expect(c.exportFormatVersion).toBe(2);
    expect(cv.container.usageContext).toContain('WEB');
    expect(Array.isArray(cv.tag)).toBe(true);
    expect(Array.isArray(cv.trigger)).toBe(true);
    expect(Array.isArray(cv.variable)).toBe(true);
  });

  it('emits every canonical GA4 event name (CANONICAL-EVENTS.md)', () => {
    const ga4Names = cv.tag
      .filter((t: { type: string }) => t.type === 'gaawe')
      .map((t: { parameter: { key: string; value: string }[] }) =>
        t.parameter.find((p) => p.key === 'eventName')?.value);
    for (const name of [
      'contact_form_submitted', 'callback_request_submitted', 'phone_number_clicked',
      'email_address_clicked', 'whatsapp_button_clicked', 'quote_calculator_submitted',
      'consultation_request_submitted', 'training_signup_submitted', 'booking_link_clicked',
    ]) {
      expect(ga4Names).toContain(name);
    }
  });

  it('has a Custom Event trigger per canonical dataLayer event', () => {
    const events = cv.trigger
      .filter((t: { type: string }) => t.type === 'CUSTOM_EVENT')
      .map((t: { customEventFilter: { parameter: { key: string; value: string }[] }[] }) =>
        t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value);
    for (const name of [
      'quote_calculator_submitted', 'contact_form_submitted', 'callback_request_submitted', 'phone_number_clicked',
      'email_address_clicked', 'whatsapp_button_clicked', 'quote_calculator_submitted',
      'consultation_request_submitted', 'training_signup_submitted', 'booking_link_clicked',
    ]) {
      expect(events).toContain(name);
    }
  });

  // 6.22.0 — booking_link_clicked: Pixel Contact (= events.json meta, dedup with
  // the CAPI leg) but NOT the shared Ads conversion tag (secondary lead, one label).
  it('booking_link_clicked fires Pixel Contact + GA4 (with link_host), not the Ads conversion tag', () => {
    const trig = cv.trigger.find((t: { name: string }) => t.name === 'CE - booking_link_clicked');
    expect(trig).toBeTruthy();
    const byName = (n: string) => cv.tag.find((t: { name: string }) => t.name === n);
    expect(byName('Meta Pixel - Contact').firingTriggerId).toContain(trig.triggerId);
    expect(byName('Google Ads - Conversion').firingTriggerId).not.toContain(trig.triggerId);
    const ga4 = byName('GA4 - booking_link_clicked');
    expect(ga4.firingTriggerId).toEqual([trig.triggerId]);
    const params = JSON.stringify(ga4.parameter);
    expect(params).toContain('link_host');
    expect(params).not.toContain('{{DLV - value}}');
  });

  it('Meta Pixel tags use the shared event_id for dedup', () => {
    const pixelTags = cv.tag.filter((t: { name: string }) => t.name.startsWith('Meta Pixel - '));
    const lead = pixelTags.find((t: { name: string }) => t.name.endsWith('Lead'));
    const html = lead.parameter.find((p: { key: string }) => p.key === 'html').value as string;
    expect(html).toContain('{{DLV - event_id}}');
  });

  // 6.14.0 — a két további leadgen-konverzió Meta standard eseménye UGYANAZ,
  // mint amit a gateway CAPI-lába küld (events.json `meta`): Schedule /
  // CompleteRegistration. Más név = a Pixel↔CAPI dedup-pár sosem találkozik.
  it('Meta Pixel Schedule / CompleteRegistration tags fire on the canonical triggers with the shared event_id', () => {
    const triggerIdByEvent = new Map<string, string>(
      cv.trigger
        .filter((t: { type: string }) => t.type === 'CUSTOM_EVENT')
        .map((t: { triggerId: string; customEventFilter: { parameter: { key: string; value: string }[] }[] }) =>
          [t.customEventFilter[0].parameter.find((p) => p.key === 'arg1')?.value, t.triggerId]),
    );
    const cases = [
      ['Meta Pixel - Schedule', 'Schedule', 'consultation_request_submitted'],
      ['Meta Pixel - CompleteRegistration', 'CompleteRegistration', 'training_signup_submitted'],
    ] as const;
    for (const [tagName, metaEvent, dlEvent] of cases) {
      const tag = cv.tag.find((t: { name: string }) => t.name === tagName);
      expect(tag, tagName).toBeTruthy();
      const html = tag.parameter.find((p: { key: string }) => p.key === 'html').value as string;
      expect(html).toContain(`fbq('track','${metaEvent}'`);
      expect(html).toContain('{{DLV - event_id}}');
      expect(tag.firingTriggerId).toEqual([triggerIdByEvent.get(dlEvent)]);
      const adTypes = tag.consentSettings.consentType.list.map((x: { value: string }) => x.value);
      expect(adTypes).toContain('ad_storage');
      expect(adTypes).toContain('ad_user_data');
    }
  });

  it('User-Provided Data variable reads the side-channel, NOT a Data Layer Variable', () => {
    const upd = cv.variable.find((v: { name: string }) => v.name === 'CJS - User Provided Data');
    expect(upd.type).toBe('jsm');
    const js = upd.parameter.find((p: { key: string }) => p.key === 'javascript').value as string;
    expect(js).toContain('window.__sbUserData');
  });

  it('ad-platform tags gate on ad consent; GA4 tags on analytics consent', () => {
    const ads = cv.tag.find((t: { type: string }) => t.type === 'awct');
    const adTypes = ads.consentSettings.consentType.list.map((x: { value: string }) => x.value);
    expect(adTypes).toContain('ad_storage');
    expect(adTypes).toContain('ad_user_data');

    const ga4 = cv.tag.find((t: { name: string }) => t.name === 'GA4 - contact_form_submitted');
    const anTypes = ga4.consentSettings.consentType.list.map((x: { value: string }) => x.value);
    expect(anTypes).toContain('analytics_storage');
  });
});
