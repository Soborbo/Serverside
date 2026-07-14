/**
 * A `cloudflare:email` modul a Workers-runtime sajátja — a vitest node-környezete
 * nem tudja feloldani. A többi teszt ezért az egész `notify.ts`-t kimockolta, ami
 * viszont azt jelentette, hogy a levél MIME-szerkezetét SOHA nem ellenőrizte senki
 * (pont ezért maradhatott bent a hiányzó MIME-Version/Message-ID/Date, amitől a
 * send() dobott, a catch elnyelte, és minden riasztás csendben elveszett).
 *
 * Ez a stub a vitest.config.ts aliasán keresztül lép be, és megőrzi a nyers
 * üzenetet, hogy a notify.test.ts állíthasson rá.
 */
export class EmailMessage {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly raw: string
  ) {}
}
