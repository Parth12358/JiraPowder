// Personal ticket notes (a colour tag + comments). In the app they are saved to notes.json by
// the backend; in the browser build, to localStorage. Never sent to Jira.
import { api, inApp } from '../api';
import type { Note, Notes, TagColor } from '../types';

export const TAGS: { id: TagColor; label: string }[] = [
  { id: 'red', label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
];
const TAG_IDS = new Set<string>(TAGS.map((t) => t.id));
export const MAX_COMMENT_CHARS = 4000;

const KEY = 'jirapowder.notes';

/** Drops anything malformed, so a bad file or old format can't break rendering. */
export function cleanNotes(raw: unknown): Notes {
  const out: Notes = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const n = v as Partial<Note>;
    const tag = typeof n.tag === 'string' && TAG_IDS.has(n.tag) ? n.tag : null;
    const comments = Array.isArray(n.comments)
      ? n.comments.filter((c) => c && typeof c.text === 'string' && typeof c.at === 'string')
      : [];
    if (tag || comments.length) out[k] = { tag, comments };
  }
  return out;
}

export async function loadNotes(): Promise<Notes> {
  if (inApp()) return cleanNotes(await api.getNotes());
  try {
    return cleanNotes(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return {};
  }
}

export const isEmpty = (n: Note | undefined) => !n || (!n.tag && n.comments.length === 0);

/** Updates `notes` in place and saves that one ticket's note. With `persist` false (the app
 *  showing sample tickets) it only changes memory, so sample keys never land in notes.json. */
export async function saveNote(notes: Notes, key: string, note: Note, persist = true): Promise<void> {
  const clean: Note = { tag: note.tag ?? null, comments: note.comments };
  const prev = notes[key];
  if (isEmpty(clean)) delete notes[key];
  else notes[key] = clean;
  try {
    if (!persist) return;
    if (inApp()) await api.setNote(key, { comments: clean.comments, ...(clean.tag ? { tag: clean.tag } : {}) });
    else localStorage.setItem(KEY, JSON.stringify(notes));
  } catch (e) {
    // Put back what was there so the screen matches what's saved.
    if (prev) notes[key] = prev;
    else delete notes[key];
    throw e;
  }
}

/** Short local time for a comment, e.g. "29 Oct, 14:05". */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}
