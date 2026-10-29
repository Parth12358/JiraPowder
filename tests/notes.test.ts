import { describe, expect, it } from 'vitest';
import { cleanNotes, saveNote } from '../src/ui/notes';
import type { Notes } from '../src/types';

describe('notes', () => {
  it('drops malformed entries and unknown tags', () => {
    const n = cleanNotes({
      'PAY-1': { tag: 'red', comments: [{ at: '2026-10-29T10:00:00Z', text: 'hi' }] },
      'PAY-2': { tag: 'magenta', comments: [] },
      'PAY-3': { tag: 'blue', comments: [{ text: 5 }] },
      'PAY-4': 'nope',
    });
    expect(Object.keys(n)).toEqual(['PAY-1', 'PAY-3']);
    expect(n['PAY-3']).toEqual({ tag: 'blue', comments: [] });
    expect(cleanNotes(null)).toEqual({});
  });

  it('removes a note once it has no tag and no comments', async () => {
    const notes: Notes = {};
    await saveNote(notes, 'PAY-1', { tag: 'green', comments: [] }, false);
    expect(notes['PAY-1']?.tag).toBe('green');
    await saveNote(notes, 'PAY-1', { tag: null, comments: [] }, false);
    expect(notes).toEqual({});
  });
});
