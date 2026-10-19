import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EVENT_NAMES, SERVER_INGRESS_ONLY_EVENTS, EVENT_NAME_MAP } from '../src/types';
import { SERVER_INGRESS_ONLY_EVENTS as CLIENT_SERVER_INGRESS_ONLY } from '../soborbo-tracking/lib/event-contract';

const kitFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../soborbo-tracking/${rel}`, import.meta.url)), 'utf8');

/**
 * Regresszió (6.13.1): a skinlab 2026-08-14 óta küldi ezt a két eseményt a
 * szerver-lábon, de a gateway-oldali pár sosem olvadt be — a gateway ismeretlen
 * névként (TRK-EVT-001) némán 204-gyel eldobta őket. Ha valaki kiveszi őket az
 * events.json-ból, ez a teszt bukik, nem a leadek tűnnek el csendben.
 */
describe('training_signup_submitted / consultation_request_submitted', () => {
  const cases = [
    ['training_signup_submitted', 'CompleteRegistration'],
    ['consultation_request_submitted', 'Schedule']
  ] as const;

  it.each(cases)('%s: engedélyezett, server-ingress-only, Meta → %s', (name, meta) => {
    expect(ALLOWED_EVENT_NAMES.has(name)).toBe(true);
    expect(SERVER_INGRESS_ONLY_EVENTS.has(name)).toBe(true);
    expect(EVENT_NAME_MAP[name]).toBe(meta);
  });

  it.each(cases)('%s: a kliens-csomag szerződése is ismeri', (name) => {
    expect(CLIENT_SERVER_INGRESS_ONLY.has(name)).toBe(true);
  });

  /**
   * 6.14.0: a böngésző-láb is megvan a csomagban. A kit lib-je jsdom-ot kér, a
   * worker-suite node alatt fut — ezért itt a FORRÁST és a generált
   * GTM-konténert nézzük (a viselkedést a kit saját tesztje méri:
   * soborbo-tracking/tests/leadgen-consultation-training.test.ts). A Meta
   * standard eseménynek a konténerben UGYANANNAK kell lennie, mint a gateway
   * CAPI-lábán (EVENT_NAME_MAP) — különben a Pixel↔CAPI dedup-pár sosem
   * találkozik.
   */
  const events = kitFile('lib/events.ts');
  const container = JSON.parse(kitFile('gtm/container.json')) as {
    containerVersion: {
      trigger: Array<{ type: string; customEventFilter: Array<{ parameter: Array<{ key: string; value: string }> }> }>;
      tag: Array<{ name: string; parameter: Array<{ key: string; value: string }> }>;
    };
  };

  it.each(cases)('%s: a kit dataLayer-pusholja (böngésző-láb)', (name) => {
    expect(events).toMatch(new RegExp(`push\\(\\{ event: '${name}'`));
  });

  it.each(cases)('%s: a referencia GTM-konténer triggere és Meta Pixel tagje (%s) megvan', (name, meta) => {
    const cv = container.containerVersion;
    const trigger = cv.trigger.find(
      (t) => t.type === 'CUSTOM_EVENT' && t.customEventFilter[0]?.parameter.some((p) => p.key === 'arg1' && p.value === name)
    );
    expect(trigger, `CE - ${name}`).toBeTruthy();
    const pixel = cv.tag.find((t) => t.name === `Meta Pixel - ${meta}`);
    expect(pixel, `Meta Pixel - ${meta}`).toBeTruthy();
    expect(pixel!.parameter.find((p) => p.key === 'html')!.value).toContain(`fbq('track','${EVENT_NAME_MAP[name]}'`);
  });
});
