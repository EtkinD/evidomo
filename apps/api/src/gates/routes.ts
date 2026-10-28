import { Router, type Response } from 'express';
import {
  factConflictDecisionRequestSchema,
  gateConflictParamsSchema,
  gateRunParamsSchema,
  type ApiError,
  type FactConflictDecisionResponse,
  type FactConflictsGateResponse,
} from '@evidomo/shared';
import { currentUser, type SessionMiddleware } from '../auth/session.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import { requireJsonBody } from '../http/guards.ts';
import type { Logger } from '../logger.ts';
import { FactConflictsGateError, type FactConflictsGate } from './fact-conflicts.ts';

export interface GateRouterDeps {
  readonly gate: FactConflictsGate;
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

/**
 * Mounted at `/api/runs`, every route behind `requireUser`. A run that does not exist and a
 * run of another user's project both answer 404 `not_found`.
 */
export function createGateRouter({ gate, session, logger }: GateRouterDeps): Router {
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

  return router;
}
