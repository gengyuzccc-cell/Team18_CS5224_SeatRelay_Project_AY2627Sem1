import { describe, expect, it } from 'vitest';
import { buildWorkshopPatch } from '../src/util/workshopPatch';

const current = { title: 'Intro to Git', description: 'Bring a laptop.' };

describe('PATCH /workshops/{wsId} body (organiser "Edit details")', () => {
  it('sends only the changed fields, title trimmed', () => {
    expect(buildWorkshopPatch(current, { ...current, title: '  Intro to Git (2nd run) ' })).toEqual(
      {
        kind: 'patch',
        body: { title: 'Intro to Git (2nd run)' },
      },
    );
    expect(buildWorkshopPatch(current, { ...current, description: '' })).toEqual({
      kind: 'patch',
      body: { description: '' },
    });
  });

  it('reports no change and validation issues', () => {
    expect(buildWorkshopPatch(current, { ...current, title: ' Intro to Git ' })).toEqual({
      kind: 'unchanged',
    });
    const blank = buildWorkshopPatch(current, { ...current, title: '   ' });
    expect(blank.kind).toBe('invalid');
    const long = buildWorkshopPatch(current, { ...current, title: 'x'.repeat(201) });
    expect(long.kind).toBe('invalid');
  });
});
