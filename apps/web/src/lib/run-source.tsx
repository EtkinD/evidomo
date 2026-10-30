import {
  claimAuditGateResponseSchema,
  demoClaimAuditGateResponseSchema,
  demoExportUrl,
  demoClaimAuditGateUrl,
  demoFactConflictsGateUrl,
  demoRunExportResponseSchema,
  demoRunUrl,
  runExportResponseSchema,
  runExportUrl,
  runUrl,
  type DemoClaimAuditGateResponse,
  type RunExportResponse,
} from '@evidomo/shared';
import { createContext, useContext, type ReactNode } from 'react';
import type { ResponseSchema } from './api';
import { demoEvidenceUrls, runEvidenceUrls, type EvidenceUrls } from './evidence-urls';

/**
 * Where the run screens (monitor, both gates, pack) read from and link to. The owner's screens
 * and the public demo replay show the same components over two API prefixes; this is the one
 * place that tells them apart, so no component branches on a URL. Screens outside a provider
 * use the owner's source, so existing behaviour is the default.
 */
export interface RunSource {
  kind: 'owner' | 'demo';
  /** Query-key prefix: owner and demo caches never share an entry. */
  keyPrefix: readonly string[];
  snapshotUrl: (runId: string) => string;
  factConflictsUrl: (runId: string) => string;
  claimAuditUrl: (runId: string) => string;
  /** Gate 2 as shown: the owner's response is assignable to the demo's (which has no `decidedBy`). */
  claimAuditSchema: ResponseSchema<DemoClaimAuditGateResponse>;
  exportUrl: (runId: string) => string;
  exportSchema: ResponseSchema<RunExportResponse>;
  evidenceUrls: (runId: string) => EvidenceUrls;
  hrefs: {
    monitor: (runId: string) => string;
    conflicts: (runId: string) => string;
    review: (runId: string) => string;
    pack: (runId: string) => string;
  };
}

export const ownerRunSource: RunSource = {
  kind: 'owner',
  keyPrefix: ['runs'],
  snapshotUrl: runUrl,
  factConflictsUrl: (runId) => `${runUrl(runId)}/gates/fact-conflicts`,
  claimAuditUrl: (runId) => `${runUrl(runId)}/gates/claim-audit`,
  claimAuditSchema: claimAuditGateResponseSchema,
  exportUrl: runExportUrl,
  exportSchema: runExportResponseSchema,
  evidenceUrls: runEvidenceUrls,
  hrefs: {
    monitor: (runId) => `/runs/${runId}`,
    conflicts: (runId) => `/runs/${runId}/conflicts`,
    review: (runId) => `/runs/${runId}/review`,
    pack: (runId) => `/runs/${runId}/pack`,
  },
};

export const demoRunSource: RunSource = {
  kind: 'demo',
  keyPrefix: ['demo', 'runs'],
  snapshotUrl: demoRunUrl,
  factConflictsUrl: demoFactConflictsGateUrl,
  claimAuditUrl: demoClaimAuditGateUrl,
  claimAuditSchema: demoClaimAuditGateResponseSchema,
  exportUrl: demoExportUrl,
  exportSchema: demoRunExportResponseSchema,
  evidenceUrls: demoEvidenceUrls,
  hrefs: {
    monitor: (runId) => `/demo/runs/${runId}`,
    conflicts: (runId) => `/demo/runs/${runId}/conflicts`,
    review: (runId) => `/demo/runs/${runId}/review`,
    pack: (runId) => `/demo/runs/${runId}/pack`,
  },
};

const RunSourceContext = createContext<RunSource>(ownerRunSource);

export function RunSourceProvider({
  source,
  children,
}: {
  source: RunSource;
  children: ReactNode;
}) {
  return <RunSourceContext.Provider value={source}>{children}</RunSourceContext.Provider>;
}

export function useRunSource(): RunSource {
  return useContext(RunSourceContext);
}

/** `['runs', runId, ...rest]` for the owner, `['demo', 'runs', runId, ...rest]` for the demo. */
export function runScopedKey(
  source: RunSource,
  runId: string,
  ...rest: readonly string[]
): readonly string[] {
  return [...source.keyPrefix, runId, ...rest];
}
