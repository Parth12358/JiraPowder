// Typed wrappers around Tauri invoke(). Outside the desktop app (plain `vite` in a browser)
// there is no backend, so `inApp()` is false and the UI stays in Demo mode.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppError, Config, ConnectionReport, Diagnostics, Scope, Snapshot } from './types';

export const inApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Normalizes anything thrown by invoke() into { kind, message }. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) return e as AppError;
  return { kind: 'Io', message: e instanceof Error ? e.message : String(e) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const api = {
  getConfig: () => call<Config | null>('get_config'),
  saveConfig: (cfg: Config) => call<void>('save_config', { cfg }),
  setSecret: (name: string, value: string) => call<void>('set_secret', { name, value }),
  testConnection: () => call<ConnectionReport>('test_connection'),
  fetchSnapshot: (scope?: Scope) => call<Snapshot>('fetch_snapshot', { scope: scope ?? null }),
  loadCachedSnapshot: () => call<Snapshot | null>('load_cached_snapshot'),
  getDiagnostics: () => call<Diagnostics>('get_diagnostics'),
  detectFields: () => call<{ storyPoints: string | null; sprint: string | null }>('detect_fields'),
  openInJira: (key: string) => call<void>('open_in_jira', { key }),
};

export type MenuAction = 'refresh' | 'settings';

export function onMenu(fn: (a: MenuAction) => void): Promise<UnlistenFn> {
  return listen<MenuAction>('menu', (e) => fn(e.payload));
}
