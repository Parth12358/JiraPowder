// The single in-memory app state. Every view reads tickets from state.snapshot.
import type { Graph, Filter, Visible } from './graph/model';
import type { Positions } from './graph/layout';
import type { AppError, Notes, Snapshot } from './types';

export type Mode = 'flow' | 'graph';

export interface AppState {
  snapshot: Snapshot;
  graph: Graph;
  /** true while showing the built-in sample tickets */
  demo: boolean;
  filter: Filter;
  visible: Visible;
  mode: Mode;
  sel: string | null;
  pos: Positions;
  view: { x: number; y: number; s: number };
  loading: boolean;
  error: AppError | null;
  /** Warnings from the last fetch plus layout warnings (e.g. cycles). */
  warnings: string[];
  /** Personal tags and comments by ticket key (local only). */
  notes: Notes;
}
