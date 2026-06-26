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
