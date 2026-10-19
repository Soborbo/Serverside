import { describe, it, expect } from 'vitest';
import { ALLOWED_EVENT_NAMES, SERVER_INGRESS_ONLY_EVENTS, EVENT_NAME_MAP } from '../src/types';
import { SERVER_INGRESS_ONLY_EVENTS as CLIENT_SERVER_INGRESS_ONLY } from '../soborbo-tracking/lib/event-contract';

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
});
