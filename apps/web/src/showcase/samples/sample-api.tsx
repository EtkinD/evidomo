import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  claimDecisionRequestSchema,
  factConflictDecisionRequestSchema,
  runUrl,
} from '@evidomo/shared';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CLAIM } from '../../__tests__/claim-audit-fixtures';
import { marketForm } from '../../__tests__/project-fixtures';
import { runSnapshot } from '../../__tests__/gate-fixtures';
import { claimAuditApprovePath, claimAuditPath, claimDecisionPath } from '../../lib/claim-audit';
import { factConflictDecisionPath, factConflictsPath } from '../../lib/fact-conflicts';
import { RUN_ID, sampleAuditGate, sampleConflictsGate } from './sample-data';

type Decisions = Record<string, unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

const stamp = (): string => new Date().toISOString();

/** What the sample's gate decisions look like when stored, as the gate reads them back. */
function storedClaimDecision(body: unknown): unknown {
  const parsed = claimDecisionRequestSchema.parse(body);
  return { ...parsed, decidedAt: stamp() };
}

/**
 * An in-memory stand-in for the API's gate routes: the real gate views run unchanged against it,
 * so a decision in the showcase behaves as it does in the product but is kept only in this page
 * view. Returns `null` for any request it does not own, which then goes to the real `fetch`.
 */
export function createGateSampleApi(gate: 'conflicts' | 'audit') {
  let decisions: Decisions = {};

  return function handle(path: string, init: RequestInit | undefined): Response | null {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === runUrl(RUN_ID)) return json(runSnapshot());
    if (method === 'GET' && path === '/api/markets/germany/1') return json(marketForm);

    if (gate === 'conflicts') {
      if (method === 'GET' && path === factConflictsPath(RUN_ID)) {
        return json(sampleConflictsGate(decisions));
      }
      if (method === 'PUT' && path === factConflictDecisionPath(RUN_ID, 'K02')) {
        const body = factConflictDecisionRequestSchema.parse(bodyOf(init));
        const before = sampleConflictsGate();
        const conflict = before.conflicts[0];
        if (conflict === undefined) return null;
        let decision: unknown;
        if (body.choice === 'accept') {
          const side = conflict.sides.find((s) => s.factIds.includes(body.factId));
          decision = {
            choice: 'accept',
            factIds: side?.factIds ?? [body.factId],
            decidedAt: stamp(),
          };
        } else if (body.choice === 'reject') {
          decision = { choice: 'reject', decidedAt: stamp() };
        } else {
          decision = {
            choice: 'edit',
            key: body.key ?? conflict.key,
            value: body.value,
            unit: body.unit ?? null,
            basis: body.basis ?? null,
            decidedAt: stamp(),
          };
        }
        decisions = { ...decisions, K02: decision };
        return json({ ...sampleConflictsGate(decisions), resumed: true });
      }
      return null;
    }

    if (method === 'GET' && path === claimAuditPath(RUN_ID))
      return json(sampleAuditGate(decisions));
    if (method === 'PUT' && path === claimDecisionPath(RUN_ID, CLAIM.rooms)) {
      decisions = { ...decisions, [CLAIM.rooms]: storedClaimDecision(bodyOf(init)) };
      return json(sampleAuditGate(decisions));
    }
    if (method === 'POST' && path === claimAuditApprovePath(RUN_ID)) {
      // Approving would start an export and navigate to the run page; neither exists here.
      return json({ error: 'internal_error' }, 503);
    }
    return null;
  };
}

type Handler = ReturnType<typeof createGateSampleApi>;

const active = new Set<Handler>();
let realFetch: typeof globalThis.fetch | null = null;

/** One shared patch, so two samples on a page can come and go in any order and `fetch` is restored. */
function install(handler: Handler): () => void {
  if (active.size === 0) {
    const original = globalThis.fetch;
    realFetch = original;
    globalThis.fetch = (input, init) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      for (const candidate of active) {
        const response = candidate(path, init);
        if (response !== null) return Promise.resolve(response);
      }
      return original(input, init);
    };
  }
  active.add(handler);
  return () => {
    active.delete(handler);
    if (active.size === 0 && realFetch !== null) {
      globalThis.fetch = realFetch;
      realFetch = null;
    }
  };
}

/**
 * Installs the sample API over `fetch` while mounted and renders the children after that, so no
 * request of theirs can reach the network. Gives them their own query cache.
 */
export function SampleApi({
  gate,
  children,
}: {
  gate: 'conflicts' | 'audit';
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  const [handler] = useState(() => createGateSampleApi(gate));
  // Subscribing is where `fetch` gets patched (in the commit phase, never during render); the
  // snapshot says whether it already is, so the children mount only after that.
  const subscribe = useCallback(
    (notify: () => void) => {
      const uninstall = install(handler);
      notify();
      return uninstall;
    },
    [handler],
  );
  const ready = useSyncExternalStore(
    subscribe,
    () => active.has(handler),
    () => false,
  );

  return ready ? <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> : null;
}
