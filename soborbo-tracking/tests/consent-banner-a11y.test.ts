import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  panelFocusables,
  createPanelKeydownHandler,
  restoreFocus
} from '../lib/consent-banner-a11y';

/**
 * A consent-panel BILLENTYŰZETES viselkedése — eddig nulla fedés volt rajta.
 *
 * MIÉRT NEM KOZMETIKA. Egy modális párbeszéd, amit nem lehet billentyűzettel
 * elhagyni, kizárja azt a látogatót, aki egérrel nem tud dönteni. A
 * hozzájárulás viszont pont akkor nem „szabadon adott" (GDPR Art. 4(11)), ha a
 * kérdésből nincs kiút — vagyis ez a jogalap része, nem UX-finomság.
 *
 * A logika eddig a `ConsentBanner.astro` bundle-ölt `<script>`-jében élt, ahol
 * egy jsdom-teszt nem tudta lefuttatni. Ezért került külön modulba.
 */

function makePanel(opts: { disabled?: boolean; hidden?: boolean; empty?: boolean } = {}): HTMLElement {
  document.body.innerHTML = '';
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  if (!opts.empty) {
    panel.innerHTML = `
      <button data-id="close">×</button>
      <input type="checkbox" data-id="analytics" />
      <input type="checkbox" data-id="marketing" ${opts.disabled ? 'disabled' : ''} />
      <a href="/adatkezeles" data-id="policy">Tájékoztató</a>
      <button data-id="save">Mentés</button>
      ${opts.hidden ? '<button data-id="ghost" hidden>rejtett</button>' : ''}
    `;
  }
  document.body.appendChild(panel);
  return panel;
}

const byId = (panel: HTMLElement, id: string) =>
  panel.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

function tab(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('fókuszálható elemek gyűjtése', () => {
  it('gombokat, beviteli mezőket és linkeket ad, DOM-sorrendben', () => {
    const panel = makePanel();
    const ids = panelFocusables(panel).map((el) => el.dataset.id);
    expect(ids).toEqual(['close', 'analytics', 'marketing', 'policy', 'save']);
  });

  it('a `disabled` elemet KIHAGYJA', () => {
    const panel = makePanel({ disabled: true });
    expect(panelFocusables(panel).map((el) => el.dataset.id)).not.toContain('marketing');
  });

  it('a `hidden` elemet KIHAGYJA — különben a Tab-kör láthatóan megszakadna', () => {
    const panel = makePanel({ hidden: true });
    expect(panelFocusables(panel).map((el) => el.dataset.id)).not.toContain('ghost');
  });
});

describe('fókuszcsapda (Tab / Shift+Tab)', () => {
  it('az UTOLSÓ elemről a Tab az ELSŐRE ugrik vissza', () => {
    const panel = makePanel();
    const first = byId(panel, 'close');
    const last = byId(panel, 'save');
    const handler = createPanelKeydownHandler({ panel, onEscape: () => {}, activeElement: () => last });

    const focusSpy = vi.spyOn(first, 'focus');
    const e = tab();
    handler(e);

    expect(focusSpy).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('az ELSŐ elemről a Shift+Tab az UTOLSÓRA ugrik', () => {
    const panel = makePanel();
    const first = byId(panel, 'close');
    const last = byId(panel, 'save');
    const handler = createPanelKeydownHandler({ panel, onEscape: () => {}, activeElement: () => first });

    const focusSpy = vi.spyOn(last, 'focus');
    const e = tab(true);
    handler(e);

    expect(focusSpy).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('a kör KÖZEPÉN a Tab természetesen működik (nem nyeljük el)', () => {
    const panel = makePanel();
    const middle = byId(panel, 'analytics');
    const handler = createPanelKeydownHandler({ panel, onEscape: () => {}, activeElement: () => middle });

    const e = tab();
    handler(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('REJTETT panel esetén a csapda INAKTÍV — nem nyeli el az oldal Tabját', () => {
    const panel = makePanel();
    panel.hidden = true;
    const handler = createPanelKeydownHandler({
      panel, onEscape: () => {}, activeElement: () => byId(panel, 'save')
    });
    const e = tab();
    handler(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ÜRES panelen nem dobunk hibát', () => {
    const panel = makePanel({ empty: true });
    const handler = createPanelKeydownHandler({ panel, onEscape: () => {} });
    expect(() => handler(tab())).not.toThrow();
  });
});

describe('ESC — a kérdésből van kiút', () => {
  it('ESC-re meghívja a bezárót, és megeszi az eseményt', () => {
    const panel = makePanel();
    const onEscape = vi.fn();
    const handler = createPanelKeydownHandler({ panel, onEscape });

    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handler(e);

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('REJTETT panelnél az ESC NEM zár (nincs mit bezárni)', () => {
    const panel = makePanel();
    panel.hidden = true;
    const onEscape = vi.fn();
    createPanelKeydownHandler({ panel, onEscape })(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    );
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('más billentyű nem zár és nem is akadályoz', () => {
    const panel = makePanel();
    const onEscape = vi.fn();
    const handler = createPanelKeydownHandler({ panel, onEscape });
    for (const key of ['Enter', 'a', 'ArrowDown', ' ']) {
      const e = new KeyboardEvent('keydown', { key, cancelable: true });
      handler(e);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('fókusz-visszaadás', () => {
  it('a bezárás után a fókusz oda tér vissza, ahonnan a panel nyílt', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const spy = vi.spyOn(trigger, 'focus');
    restoreFocus(trigger);
    expect(spy).toHaveBeenCalled();
  });

  it('null / eltávolított elem esetén nem dobunk hibát', () => {
    expect(() => restoreFocus(null)).not.toThrow();
    const gone = document.createElement('button');
    vi.spyOn(gone, 'focus').mockImplementation(() => { throw new Error('detached'); });
    expect(() => restoreFocus(gone)).not.toThrow();
  });
});
