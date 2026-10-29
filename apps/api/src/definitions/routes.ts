import { Router, type RequestHandler } from 'express';
import {
  definitionParamsSchema,
  type MarketFormResponse,
  type MarketListResponse,
  type ServiceResponse,
} from '@evidomo/shared';
import type { SessionMiddleware } from '../auth/session.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import { marketForm, marketSummary, serviceView } from '../projects/views.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from './loader.ts';

export interface DefinitionRouterDeps {
  readonly definitions: Pick<DefinitionRegistry, 'markets' | 'getMarket' | 'getService'>;
  readonly session: SessionMiddleware;
}

/**
 * Mounted at `/api`: `GET /markets`, `GET /markets/:id/:version`, `GET /services/:id/:version`,
 * signed-in users only. Definitions are immutable per version, but responses stay `no-store`
 * like the rest of the API (a redeploy can add versions).
 */
export function createDefinitionRouter({ definitions, session }: DefinitionRouterDeps): Router {
  const router = Router();
  const guard: RequestHandler[] = [
    session.requireUser,
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
  ];

  router.get('/markets', ...guard, (_req, res) => {
    res.json({ markets: definitions.markets.map(marketSummary) } satisfies MarketListResponse);
  });

  router.get('/markets/:id/:version', ...guard, (req, res) => {
    const params = definitionParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    try {
      const market = definitions.getMarket(params.data.id, params.data.version);
      res.json({ market: marketForm(market) } satisfies MarketFormResponse);
    } catch (error) {
      if (!(error instanceof DefinitionNotFoundError)) throw error;
      sendError(res, 404, 'not_found');
    }
  });

  router.get('/services/:id/:version', ...guard, (req, res) => {
    const params = definitionParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    try {
      const service = definitions.getService(params.data.id, params.data.version);
      res.json({ service: serviceView(service) } satisfies ServiceResponse);
    } catch (error) {
      if (!(error instanceof DefinitionNotFoundError)) throw error;
      sendError(res, 404, 'not_found');
    }
  });

  return router;
}
