import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage } from '../src/lib/log-sanitize';

describe('sanitizeErrorMessage', () => {
  it('returns "unknown" for undefined/null', () => {
    expect(sanitizeErrorMessage(undefined)).toBe('unknown');
    expect(sanitizeErrorMessage('')).toBe('unknown');
  });

  it('strips email addresses', () => {
    expect(sanitizeErrorMessage('Invalid email: alice@example.com')).toBe(
      'Invalid email: [email]'
    );
  });

  it('strips emails with plus-suffix', () => {
    expect(sanitizeErrorMessage('Bad: john+spam@gmail.com here')).toBe('Bad: [email] here');
  });

  it('strips multiple emails', () => {
    expect(sanitizeErrorMessage('a@b.com and c@d.org')).toBe('[email] and [email]');
  });

  it('strips international phone numbers', () => {
    expect(sanitizeErrorMessage('Phone: +447123456789 invalid')).toBe('Phone: [phone] invalid');
  });

  it('strips spaced phone numbers', () => {
    expect(sanitizeErrorMessage('+44 (0)7123 456 789 not allowed')).toBe('[phone] not allowed');
  });

  it('strips HU-format phone numbers', () => {
    expect(sanitizeErrorMessage('Bad number 06301234567')).toBe('Bad number [phone]');
  });

  it('preserves error structure', () => {
    expect(sanitizeErrorMessage('Bad request: missing field "foo"')).toBe(
      'Bad request: missing field "foo"'
    );
  });

  it('truncates to 200 chars', () => {
    const long = 'x'.repeat(300);
    expect(sanitizeErrorMessage(long).length).toBe(200);
  });

  it('strips both email and phone in same message', () => {
    expect(sanitizeErrorMessage('user alice@email.com phone +447123456789')).toBe(
      'user [email] phone [phone]'
    );
  });

  it('redacts echoed SHA-256 hashes (hashed user_data is still PII per #13)', () => {
    const hash = 'a'.repeat(64);
    expect(sanitizeErrorMessage(`Rejected em=${hash}`)).toBe('Rejected em=[hash]');
  });

  it('redacts shorter hex runs (32+ chars) too', () => {
    const hex = 'deadbeef'.repeat(4); // 32 hex chars
    expect(sanitizeErrorMessage(`hash ${hex} bad`)).toBe('hash [hash] bad');
  });

  it('does not redact short hex-like tokens (status codes, ids)', () => {
    expect(sanitizeErrorMessage('error code abc123 at line 5')).toBe('error code abc123 at line 5');
  });
});

/**
 * Regressziós őr: az agykontroll 43× TRK-600-005 (2026-07-27 … 08-11).
 *
 * A ledgerben minden sor `Object with ID '[phone]'`-ként ült, mert a telefon-regex
 * megette a Meta által visszhangzott pixel ID-t. A tünet be nem helyettesített
 * template-változónak látszott, és a vizsgálat a gateway kódját kereste egy
 * KV-config hiba helyett. A hibás azonosítónak OLVASHATÓNAK kell maradnia — enélkül
 * a vendor_message nem mondja meg, MELYIK ID rossz, vagyis épp a saját célját
 * hiúsítja meg.
 */
describe('sanitizeErrorMessage — vendor objektum-ID megőrzése', () => {
  const NUL = String.fromCharCode(0);
  const META_400 = (id: string) =>
    `Unsupported post request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`;

  it('megőrzi a Meta pixel ID-t az "Object with ID" pozícióban', () => {
    expect(sanitizeErrorMessage(META_400('1114983601859742'))).toContain(
      "Object with ID '1114983601859742'"
    );
  });

  it('nem maszkolja [phone]-ra a 16-jegyű pixel ID-t (a konkrét regresszió)', () => {
    expect(sanitizeErrorMessage(META_400('1114983601859742'))).not.toContain('[phone]');
  });

  it('rövidebb (10-jegyű) objektum-ID is megmarad', () => {
    expect(sanitizeErrorMessage(META_400('1234567890'))).toContain("Object with ID '1234567890'");
  });

  it('megőrzi az alias-hiba (#803) azonosítóját', () => {
    const msg = '(#803) Some of the aliases you requested do not exist: 915395591548632';
    expect(sanitizeErrorMessage(msg)).toContain('915395591548632');
  });

  it('a védett ID MELLETT a valódi PII-t továbbra is maszkolja', () => {
    const msg = `Object with ID '1114983601859742' rejected for alice@example.com / +447123456789`;
    const out = sanitizeErrorMessage(msg);
    expect(out).toContain("Object with ID '1114983601859742'");
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('447123456789');
  });

  it('a telefon-maszkolás változatlan, ha NEM objektum-ID pozícióban áll', () => {
    // Ugyanaz a számsor, vendor-frázis nélkül → PII-ként kezelendő. A kivétel
    // SZŰK: a kontextushoz kötött, nem a számsor alakjához.
    expect(sanitizeErrorMessage('Invalid value 1114983601859742 supplied')).toBe(
      'Invalid value [phone] supplied'
    );
  });

  it('nem hagy sentinel-maradékot a 200 karakteres vágásnál', () => {
    const out = sanitizeErrorMessage(`${META_400('1114983601859742')} ${'x'.repeat(300)}`);
    expect(out.length).toBe(200);
    expect(out).not.toContain('OBJID');
    expect(out).not.toContain(NUL);
  });

  it('egy üzenetben több objektum-ID is megmarad', () => {
    const msg = `Object with ID '111222333444555' failed; Object with ID '999888777666555' failed`;
    const out = sanitizeErrorMessage(msg);
    expect(out).toContain('111222333444555');
    expect(out).toContain('999888777666555');
  });

  it('a sentinel-szerű felhasználói szöveg nem zavarja meg a visszacserélést', () => {
    // A sentinel NUL-határolt, tehát sima vendor-szövegben nem állítható elő.
    const out = sanitizeErrorMessage("OBJID0 is not an id, but Object with ID '1234567890' is");
    expect(out).toContain('OBJID0 is not an id');
    expect(out).toContain("Object with ID '1234567890'");
  });
});
