import { describe, it, expect } from 'vitest';
import { sendAdminEmail } from '../src/lib/notify';
import type { Env } from '../src/env';

/**
 * A riasztási lánc a rendszer legcsendesebben romló darabja: a sendAdminEmail
 * MINDEN hibát elnyel, tehát egy hibás levél úgy néz ki, mintha minden rendben
 * lenne — egészen egy valódi incidensig, amikor nem jön levél.
 *
 * A Cloudflare `send_email` bindingje RFC 5322-konform üzenetet vár. A korábbi
 * kézzel épített levélből hiányzott a MIME-Version, a Message-ID és a Date —
 * ettől a send() dobott. Ezek a tesztek pontosan ezt szögezik le.
 */

type Captured = { raw: string; from: string; to: string };

function envWithBinding(sent: Captured[], throwOnSend = false): Env {
  return {
    ADMIN_EMAIL: {
      async send(msg: Captured) {
        if (throwOnSend) throw new Error('destination address not verified');
        sent.push(msg);
      }
    }
  } as unknown as Env;
}

/** A fejlécblokk a törzstől egy ÜRES sorral válik el (CRLFCRLF). */
function headersOf(raw: string): string {
  return raw.split('\r\n\r\n')[0];
}
function bodyOf(raw: string): string {
  return raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
}

describe('sendAdminEmail — RFC 5322 MIME szerkezet', () => {
  it('kiteszi a kötelező fejléceket, amelyek hiánya miatt a send() dobott', async () => {
    const sent: Captured[] = [];
    const ok = await sendAdminEmail(envWithBinding(sent), 'Zero conversions', '<p>hi</p>', 'critical');

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const headers = headersOf(sent[0].raw);

    expect(headers).toMatch(/^MIME-Version: 1\.0$/m);
    expect(headers).toMatch(/^Message-ID: <[^>]+@soborbo\.co\.uk>$/m);
    expect(headers).toMatch(/^Date: .+\+0000$/m);
    expect(headers).toMatch(/^Content-Type: text\/html; charset=UTF-8$/m);
    expect(headers).toMatch(/^From: tracking-alerts@soborbo\.co\.uk$/m);
    expect(headers).toMatch(/^To: laszlo@soborbo\.co\.uk$/m);
  });

  it('a Date RFC 5322-ként parse-olható (nem ISO-8601)', async () => {
    const sent: Captured[] = [];
    await sendAdminEmail(envWithBinding(sent), 'x', '<p>x</p>');

    const date = headersOf(sent[0].raw).match(/^Date: (.+)$/m)![1];
    expect(date).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO-8601 itt hibás lenne
    expect(date).toMatch(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} /); // RFC 5322 day-of-week + dátum
    expect(Number.isNaN(Date.parse(date))).toBe(false);
  });

  it('minden levél egyedi Message-ID-t kap', async () => {
    const sent: Captured[] = [];
    const env = envWithBinding(sent);
    await sendAdminEmail(env, 'a', '<p>a</p>');
    await sendAdminEmail(env, 'b', '<p>b</p>');

    const ids = sent.map((m) => m.raw.match(/^Message-ID: (.+)$/m)![1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('a törzs base64, és visszafejtve az eredeti UTF-8 HTML', async () => {
    const sent: Captured[] = [];
    // Magyar ékezet + tipográfiai idézőjel: a digest/riasztás törzse valóban ilyen.
    const html = '<p>„zero conversions" — Pécs, árvíztűrő tükörfúrógép</p>';
    await sendAdminEmail(envWithBinding(sent), 'x', html);

    const raw = sent[0].raw;
    expect(headersOf(raw)).toMatch(/^Content-Transfer-Encoding: base64$/m);

    const decoded = Buffer.from(bodyOf(raw).replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decoded).toBe(html);
  });

  it('a base64 törzs sorai nem lépik túl a 76 karaktert (RFC 2045)', async () => {
    const sent: Captured[] = [];
    await sendAdminEmail(envWithBinding(sent), 'x', '<p>' + 'a'.repeat(500) + '</p>');

    for (const line of bodyOf(sent[0].raw).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('a nem-ASCII subject RFC 2047 encoded-word (a nyers 8-bites fejléc illegális)', async () => {
    const sent: Captured[] = [];
    await sendAdminEmail(envWithBinding(sent), 'Nincs konverzió — Pécs', '<p>x</p>', 'warning');

    const subject = headersOf(sent[0].raw).match(/^Subject: (.+)$/m)![1];
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(subject)).toBe(false);

    const decoded = Buffer.from(subject.slice(10, -2), 'base64').toString('utf8');
    expect(decoded).toBe('[WARNING] Nincs konverzió — Pécs');
  });

  it('az ASCII subject marad olvasható, a level prefixszel', async () => {
    const sent: Captured[] = [];
    await sendAdminEmail(envWithBinding(sent), 'Zero conversions', '<p>x</p>', 'critical');

    expect(headersOf(sent[0].raw)).toMatch(/^Subject: \[CRITICAL\] Zero conversions$/m);
  });
});

describe('sendAdminEmail — a hiba nem csordul ki, de nem is hazudik', () => {
  it('false, ha nincs binding (és nem dob)', async () => {
    const ok = await sendAdminEmail({} as Env, 'x', '<p>x</p>');
    expect(ok).toBe(false);
  });

  it('false, ha a binding elutasítja — a hívó (konverziós út) NEM dől el tőle', async () => {
    const ok = await sendAdminEmail(envWithBinding([], true), 'x', '<p>x</p>');
    expect(ok).toBe(false);
  });
});
