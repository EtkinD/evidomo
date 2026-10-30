import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Mode } from './palettes';

const STORAGE_KEY = 'evidomo-showcase-mode';
const listeners = new Set<() => void>();

// Fallback when localStorage is unavailable (private mode): the choice lives for this page view.
let memoryMode: Mode | null = null;

function readMode(): Mode {
  if (memoryMode !== null) return memoryMode;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function writeMode(mode: Mode): void {
  memoryMode = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Kept in memoryMode above.
  }
  listeners.forEach((listener) => listener());
}

interface ModeValue {
  readonly mode: Mode;
  readonly setMode: (mode: Mode) => void;
}

const ModeContext = createContext<ModeValue>({ mode: 'light', setMode: () => undefined });

/** Light/dark choice shared by every showcase sub-page (kept in localStorage). */
export function ModeProvider({ children }: { children: ReactNode }) {
  // The server and the first client render use "light", so hydration matches.
  const mode = useSyncExternalStore(subscribe, readMode, () => 'light' as const);
  return (
    <ModeContext.Provider value={{ mode, setMode: writeMode }}>{children}</ModeContext.Provider>
  );
}

export function useMode(): ModeValue {
  return useContext(ModeContext);
}
