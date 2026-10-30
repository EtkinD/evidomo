import type { ComponentType } from 'react';
import { IntlProvider } from 'use-intl';
import en from '../../messages/en.json';
import { ModeProvider } from './mode';

/**
 * Marks a page as rendered without the product shell and auth gate (read by `_app`), and gives it
 * the shared light/dark choice. Nothing else mounts `ModeProvider`, so without this the mode
 * switch would be a no-op.
 */
export function bare<P extends object>(Page: ComponentType<P>): ComponentType<P> & { bare: true } {
  function Bare(props: P) {
    return (
      // The showcase is dev-only and English: it has no per-page messages, so it brings them.
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <ModeProvider>
          <Page {...props} />
        </ModeProvider>
      </IntlProvider>
    );
  }
  return Object.assign(Bare, { bare: true as const });
}
