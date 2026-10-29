// The one user that owns public demo runs (P4-09, docs/architecture.md §10 and §11).
// `npm run demo:seed` creates it with an unknowable password, so it can never log in. Two rules
// key on it: the demo API serves only runs of this user's projects (on top of `DEMO_RUN_IDS`),
// and their replayed usage does not count against the global daily cap.

/** `.invalid` never resolves; stored lower-cased like every email. */
export const DEMO_OWNER_EMAIL = 'demo-replay@evidomo.invalid';
