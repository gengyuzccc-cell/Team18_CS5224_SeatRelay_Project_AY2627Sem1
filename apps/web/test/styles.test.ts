import { describe, expect, it } from 'vitest';
import css from '../src/styles.css?raw';

/**
 * Layout regressions found in the real-browser walkthrough (tools/e2e): a `.btn` that is a
 * direct child of a column flex container was stretched across it ("Edit details", "Add
 * session", "Go to the organiser area", "Cancel session"), and the wizard's Mode select sat
 * lower than the Hold input because the row aligned at the bottom of the help text.
 */

/** selector → declarations (property → value) for every plain rule of the stylesheet. */
function rules(source: string): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const part of (match[2] ?? '').split(';')) {
      const [property, ...value] = part.split(':');
      if (property !== undefined && value.length > 0) {
        declarations.set(property.trim(), value.join(':').trim());
      }
    }
    for (const selector of (match[1] ?? '').split(',')) {
      const key = selector.trim().replace(/\s+/g, ' ');
      map.set(key, new Map([...(map.get(key) ?? []), ...declarations]));
    }
  }
  return map;
}

const sheet = rules(css);

describe('styles.css layout rules', () => {
  it('column flex containers do not stretch a button child', () => {
    for (const container of ['.stack', '.stack-tight', '.card']) {
      expect(sheet.get(container)?.get('display'), container).toBe('flex');
      expect(sheet.get(container)?.get('flex-direction'), container).toBe('column');
    }
    expect(sheet.get('.stack > .btn')?.get('align-self')).toBe('flex-start');
    expect(sheet.get('.stack-tight > .btn')?.get('align-self')).toBe('flex-start');
    expect(sheet.get('.card:not(.panel-center) > .btn')?.get('align-self')).toBe('flex-start');
  });

  it('centred panels keep their centred button', () => {
    expect(sheet.get('.panel-center')?.get('align-items')).toBe('center');
    expect(sheet.has('.card > .btn')).toBe(false);
  });

  it('a field row with help text can align its fields at the top', () => {
    expect(sheet.get('.field-row')?.get('align-items')).toBe('flex-end');
    expect(sheet.get('.field-row.field-row-top')?.get('align-items')).toBe('flex-start');
  });

  it('honours reduced motion: every animation is cut short, the infinite ones stop', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = rules(css.slice(start + '@media (prefers-reduced-motion: reduce) {'.length));
    expect(block.get('*')?.get('animation-duration')).toBe('0.01ms !important');
    expect(block.get('*')?.get('animation-iteration-count')).toBe('1 !important');
    expect(block.get('*')?.get('transition-duration')).toBe('0.01ms !important');
    // Each rule that loops forever is switched off outright in the reduced-motion block.
    for (const [selector, declarations] of sheet) {
      if (/\binfinite\b/.test(declarations.get('animation') ?? '')) {
        expect(block.get(selector)?.get('animation'), selector).toBe('none !important');
      }
    }
    for (const selector of [
      '.badge-cancelling',
      '.badge-offered::before',
      '.spinner',
      '.icon.spin',
    ]) {
      expect(block.get(selector)?.get('animation'), selector).toBe('none !important');
    }
  });

  it('table cells do not use tabular figures (tabular hyphens pad "cut-off" and e-mails)', () => {
    expect(sheet.get('table')?.get('font-variant-numeric')).toBeUndefined();
    expect(sheet.get('.num')?.get('font-variant-numeric')).toBe('tabular-nums');
  });

  it('the small capacity input in a copy row keeps its own width', () => {
    expect(sheet.get('.copy-row .input-small')?.get('flex')).toBe('0 0 5.5rem');
  });

  it('the preference checkbox stays a visible native control', () => {
    for (const [selector, declarations] of sheet) {
      if (!selector.includes('.pref-row') || !selector.includes('input')) {
        continue;
      }
      expect(declarations.get('opacity'), selector).not.toBe('0');
      expect(declarations.get('display'), selector).not.toBe('none');
    }
  });
});
