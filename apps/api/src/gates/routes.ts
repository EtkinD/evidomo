import { Router, type Response } from 'express';
import {
  claimAuditApproveRequestSchema,
  claimAuditClaimParamsSchema,
  claimAuditImageParamsSchema,
  claimDecisionRequestSchema,
  factConflictDecisionRequestSchema,
  gateConflictParamsSchema,
  gateRunParamsSchema,
  stagedImageDecisionRequestSchema,
  type ApiError,
  type ClaimAuditGateResponse,
  type FactConflictDecisionResponse,
  type FactConflictsGateResponse,
} from '@evidomo/shared';
import { currentUser, type SessionMiddleware } from '../auth/session.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import { requireJsonBody } from '../http/guards.ts';
import type { Logger } from '../logger.ts';
import { ClaimAuditGateError, type ClaimAuditGate } from './claim-audit.ts';
import { FactConflictsGateError, type FactConflictsGate } from './fact-conflicts.ts';

export interface GateRouterDeps {
  readonly gate: FactConflictsGate;
  readonly claimAudit: ClaimAuditGate;
  readonly session: SessionMiddleware;
  readonly logger: Logger;
}

function sendGateError(res: Response, error: FactConflictsGateError): void {
  switch (error.reason) {
    case 'run_not_found':
    case 'conflict_not_found':
      sendError(res, 404, 'not_found');
      return;
    case 'gate_not_open':
      sendError(res, 409, 'gate_not_open');
      return;
    case 'fact_not_in_conflict':
      sendError(res, 400, 'fact_not_in_conflict');
      return;
    case 'invalid_decision':
      res
        .status(400)
        .json({ error: 'validation_failed', issues: [...error.issues] } satisfies ApiError);
      return;
    default: {
      const unreachable: never = error.reason;
      throw new Error(`Unhandled gate error ${String(unreachable)}`);
    }
  }
}

function sendClaimAuditError(res: Response, error: ClaimAuditGateError): void {
  switch (error.reason) {
    case 'run_not_found':
    case 'target_not_found':
      sendError(res, 404, 'not_found');
      return;
    case 'gate_not_open':
      sendError(res, 409, 'gate_not_open');
      return;
    case 'decisions_pending':
      sendError(res, 409, 'gate_decisions_pending');
      return;
    case 'edit_rejected':
      res
        .status(400)
        .json({ error: 'claim_edit_rejected', findings: [...error.findings] } satisfies ApiError);
      return;
    default: {
      const unreachable: never = error.reason;
      throw new Error(`Unhandled gate error ${String(unreachable)}`);
    }
  }
}

/**
 * Mounted at `/api/runs`, every route behind `requireUser`. A run that does not exist and a
 * run of another user's project both answer 404 `not_found`.
 */
export function createGateRouter({ gate, claimAudit, session, logger }: GateRouterDeps): Router {
  const router = Router();
  router.use(session.requireUser);
  router.use(requireJsonBody);
  router.use((_req, res, next) => {
    // Responses carry property data and decision state: never cached.
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/:runId/gates/fact-conflicts', async (req, res) => {
    const params = gateRunParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    try {
      const body = await gate.get(currentUser(req).id, params.data.runId);
      res.json(body satisfies FactConflictsGateResponse);
    } catch (error) {
      if (!(error instanceof FactConflictsGateError)) throw error;
      sendGateError(res, error);
    }
  });

  router.put('/:runId/gates/fact-conflicts/conflicts/:conflictId/decision', async (req, res) => {
    const params = gateConflictParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const decision = factConflictDecisionRequestSchema.safeParse(req.body);
    if (!decision.success) {
      sendValidationError(res, decision.error);
      return;
    }
    const user = currentUser(req);
    try {
      const body = await gate.decide(
        user.id,
        params.data.runId,
        params.data.conflictId,
        decision.data,
      );
      // IDs and the choice only: values and keys describe the property.
      logger.info(
        {
          userId: user.id,
          runId: params.data.runId,
          conflictId: params.data.conflictId,
          choice: decision.data.choice,
          openCount: body.openCount,
          resumed: body.resumed,
        },
        'gate 1 decision recorded',
      );
      res.json(body satisfies FactConflictDecisionResponse);
    } catch (error) {
      if (!(error instanceof FactConflictsGateError)) throw error;
      sendGateError(res, error);
    }
  });

  router.get('/:runId/gates/claim-audit', async (req, res) => {
    const params = gateRunParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    try {
      const body = await claimAudit.get(currentUser(req).id, params.data.runId);
      res.json(body satisfies ClaimAuditGateResponse);
    } catch (error) {
      if (!(error instanceof ClaimAuditGateError)) throw error;
      sendClaimAuditError(res, error);
    }
  });

  router.put('/:runId/gates/claim-audit/claims/:claimId/decision', async (req, res) => {
    const params = claimAuditClaimParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const decision = claimDecisionRequestSchema.safeParse(req.body);
    if (!decision.success) {
      sendValidationError(res, decision.error);
      return;
    }
    const user = currentUser(req);
    try {
      const body = await claimAudit.decideClaim(
        user.id,
        params.data.runId,
        params.data.claimId,
        decision.data,
      );
      // IDs and the choice only: edited text is copy (personal-data scope).
      logger.info(
        {
          userId: user.id,
          runId: params.data.runId,
          claimId: params.data.claimId,
          choice: decision.data.choice,
          openCount: body.openCount,
        },
        'gate 2 claim decision recorded',
      );
      res.json(body satisfies ClaimAuditGateResponse);
    } catch (error) {
      if (!(error instanceof ClaimAuditGateError)) throw error;
      sendClaimAuditError(res, error);
    }
  });

  router.put('/:runId/gates/claim-audit/images/:artifactId/decision', async (req, res) => {
    const params = claimAuditImageParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const decision = stagedImageDecisionRequestSchema.safeParse(req.body);
    if (!decision.success) {
      sendValidationError(res, decision.error);
      return;
    }
    const user = currentUser(req);
    try {
      const body = await claimAudit.decideImage(
        user.id,
        params.data.runId,
        params.data.artifactId,
        decision.data,
      );
      logger.info(
        {
          userId: user.id,
          runId: params.data.runId,
          artifactId: params.data.artifactId,
          choice: decision.data.choice,
          openCount: body.openCount,
        },
        'gate 2 image decision recorded',
      );
      res.json(body satisfies ClaimAuditGateResponse);
    } catch (error) {
      if (!(error instanceof ClaimAuditGateError)) throw error;
      sendClaimAuditError(res, error);
    }
  });

  router.post('/:runId/gates/claim-audit/approve', async (req, res) => {
    const params = gateRunParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const body = claimAuditApproveRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error);
      return;
    }
    const user = currentUser(req);
    try {
      const gate2 = await claimAudit.approve(user.id, params.data.runId);
      logger.info(
        { userId: user.id, runId: params.data.runId, warningCount: gate2.warnings.length },
        'gate 2 approved; run resumed',
      );
      res.json(gate2 satisfies ClaimAuditGateResponse);
    } catch (error) {
      if (!(error instanceof ClaimAuditGateError)) throw error;
      sendClaimAuditError(res, error);
    }
  });

  return router;
}
