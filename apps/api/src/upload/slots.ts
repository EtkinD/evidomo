// In-flight upload slots, taken before a body is received: the processing limiter only bounds
// decoding, while receiving writes up to 128 MiB per request to the temp disk. In-process (a
// restart resets them), like the auth rate limits.

export interface UploadSlotLimits {
  /** Uploads one user may have in flight (receiving or processing). */
  readonly perUser: number;
  /** Uploads the process accepts in flight across all users. */
  readonly total: number;
}

export const DEFAULT_UPLOAD_SLOT_LIMITS: UploadSlotLimits = { perUser: 2, total: 6 };

/** Releases the slot; safe to call more than once. */
export type ReleaseUploadSlot = () => void;

export interface UploadSlots {
  /** A slot for `userId`, or undefined when the user's or the process's limit is reached. */
  tryAcquire(userId: string): ReleaseUploadSlot | undefined;
  /** In-flight uploads, for tests and diagnostics. */
  inFlight(): { readonly total: number; readonly users: number };
}

export function createUploadSlots(
  limits: UploadSlotLimits = DEFAULT_UPLOAD_SLOT_LIMITS,
): UploadSlots {
  const perUser = new Map<string, number>();
  let total = 0;
  return {
    tryAcquire(userId) {
      const held = perUser.get(userId) ?? 0;
      if (held >= limits.perUser || total >= limits.total) return undefined;
      perUser.set(userId, held + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (perUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) perUser.delete(userId);
        else perUser.set(userId, remaining);
      };
    },
    inFlight: () => ({ total, users: perUser.size }),
  };
}
