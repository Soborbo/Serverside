/**
 * A consent-panel akadálymentességi viselkedése — fókuszcsapda, ESC, fókusz-
 * visszaadás.
 *
 * MIÉRT KÜLÖN MODUL. Ez a logika eddig a `ConsentBanner.astro` bundle-ölt
 * `<script>`-jében élt, TypeScript-tel és importokkal — vagyis egy jsdom-teszt
 * nem tudta lefuttatni, és NULLA fedés volt rajta. Márpedig ez nem kozmetika:
 * egy modális párbeszéd, amit nem lehet billentyűzettel elhagyni, kizárja azt a
 * látogatót, aki egérrel nem tud dönteni — a hozzájárulás pedig pont akkor nem
 * „szabadon adott", ha a kérdésből nincs kiút.
 *
 * A modul SZÁNDÉKOSAN DOM-tiszta és állapotmentes: kap egy panelt és egy
 * bezáró-visszahívást, és nem tud semmit a consentről.
 */

/**
 * A panelben ténylegesen fókuszálható elemek, DOM-sorrendben.
 *
 * A `disabled` és a `hidden` kizárása nem részletkérdés: egy rejtett elem a
 * csapda „szélén" oda ugratná a fókuszt, ahonnan a felhasználó nem lát semmit,
 * és a Tab-kör láthatóan megszakadna.
 */
export function panelFocusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled') && !el.hasAttribute('hidden'));
}

export interface PanelKeydownOptions {
  panel: HTMLElement;
  /** ESC → a hívó dönti el, mi történjen (banner vissza vagy bezárás). */
  onEscape: () => void;
  /** Tesztelhetőség: melyik elem az aktív (alapból `document.activeElement`). */
  activeElement?: () => Element | null;
}

/**
 * A panel billentyű-kezelője: ESC-re zár, Tab-ra körbeforgatja a fókuszt.
 *
 * A csapda CSAK akkor aktív, ha a panel látszik — különben egy háttérben lévő
 * rejtett panel elnyelné a Tabot az egész oldalról.
 */
export function createPanelKeydownHandler(
  opts: PanelKeydownOptions
): (e: KeyboardEvent) => void {
  const active = opts.activeElement ?? (() => document.activeElement);

  return function onPanelKeydown(e: KeyboardEvent): void {
    if (opts.panel.hidden) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onEscape();
      return;
    }

    if (e.key !== 'Tab') return;

    const f = panelFocusables(opts.panel);
    if (f.length === 0) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;

    if (e.shiftKey && active() === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active() === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * A fókusz visszaadása oda, ahonnan a panel megnyílt.
 *
 * Enélkül a bezárás után a fókusz a `<body>`-ra esik vissza: a
 * billentyűzet-használó elveszíti a helyét az oldalon, és a képernyőolvasó
 * elölről kezdi a felolvasást.
 */
export function restoreFocus(previous: Element | null): void {
  if (previous instanceof HTMLElement && typeof previous.focus === 'function') {
    try { previous.focus(); } catch { /* leszedett elem — nincs hova visszaadni */ }
  }
}
