import type { FunctionComponent } from 'react';

/** Marks a page as rendered without the product shell and auth gate (read by `_app`). */
export function bare<P>(component: FunctionComponent<P>): FunctionComponent<P> & { bare: true } {
  return Object.assign(component, { bare: true as const });
}
