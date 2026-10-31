import { useSyncExternalStore } from 'react';

/**
 * "Show sources": whether the landing page marks every claim with its source. The choice is
 * remembered per viewer in localStorage; every access is guarded, because storage throws in some
 * private modes and when site data is blocked. Without storage the choice still holds for this
 * page view (module memory). `?sources=on` turns it on without storing it.
 */
export const SOURCES_STORAGE_KEY = 'evidomo-sources';

let current: boolean | null = null;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(SOURCES_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function snapshot(): boolean {
  current ??= readStored();
  return current;
}

/** Returns false when the choice could not be stored (it still applies to this page view). */
export function setShowSources(on: boolean): boolean {
  current = on;
  emit();
  try {
    if (on) window.localStorage.setItem(SOURCES_STORAGE_KEY, 'on');
    else window.localStorage.removeItem(SOURCES_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Applies `?sources=on` from the address, for this view only. */
export function applySourcesFromUrl(search: string): void {
  if (new URLSearchParams(search).get('sources') === 'on' && !snapshot()) {
    current = true;
    emit();
  }
}

/** Test hook: forget the cached choice so the next read goes to storage again. */
export function resetShowSources(): void {
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === SOURCES_STORAGE_KEY) {
      current = readStored();
      emit();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The server and the first client render say off; the stored choice follows right after. */
export function useShowSources(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
