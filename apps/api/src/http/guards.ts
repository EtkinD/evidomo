import type { Request, RequestHandler } from 'express';
import { sendError } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isStateChanging(req: Request): boolean {
  return !SAFE_METHODS.has(req.method);
}

/**
 * CSRF defense in depth on top of the SameSite=Lax session cookie: a state-changing request
 * whose `Origin` is present and not the app's own origin is rejected (403), as is one the
 * browser labels `Sec-Fetch-Site: cross-site`. Requests without either header (curl, server
 * to server) pass; they carry no ambient browser cookies to abuse.
 */
export function rejectCrossOrigin(appOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (!isStateChanging(req)) {
      next();
      return;
    }
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if ((origin !== undefined && origin !== appOrigin) || fetchSite === 'cross-site') {
      sendError(res, 403, 'forbidden_origin');
      return;
    }
    next();
  };
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/**
 * For JSON routers: a state-changing request that carries a body must declare
 * `application/json` (415 otherwise). This blocks the content types an HTML form or a
 * no-preflight `fetch` can send cross-site. Bodiless requests (logout) pass.
 */
export const requireJsonBody: RequestHandler = (req, res, next) => {
  if (isStateChanging(req) && hasBody(req) && req.is('application/json') === false) {
    sendError(res, 415, 'unsupported_media_type');
    return;
  }
  next();
};
