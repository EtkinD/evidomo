export type Flash = { kind: 'project_deleted'; title: string } | { kind: 'project_gone' };

// Module state, not the URL or storage: it survives the client-side navigation that follows a
// deletion, but a crafted link cannot make the app claim something it did not do, and a reload
// shows nothing stale.
let pending: Flash | null = null;

/** A one-shot message for the next page (here: after a project is deleted). */
export function setFlash(flash: Flash): void {
  pending = flash;
}

/** Pure read, safe in a state initialiser; `clearFlash` consumes it. */
export function peekFlash(): Flash | null {
  return pending;
}

export function clearFlash(): void {
  pending = null;
}
