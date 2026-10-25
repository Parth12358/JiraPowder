// Runs the force layout off the UI thread for large maps (see map.ts graphLayout).
import { forceLayout } from './layout';

self.onmessage = (e: MessageEvent<{ id: number; keys: string[]; edges: [string, string][] }>) => {
  const { id, keys, edges } = e.data;
  self.postMessage({ id, pos: forceLayout(keys, edges) });
};
