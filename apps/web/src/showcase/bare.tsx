import type { ComponentType } from 'react';
import { ModeProvider } from './mode';

/**
 * Marks a page as rendered without the product shell and auth gate (read by `_app`), and gives it
 * the shared light/dark choice. Nothing else mounts `ModeProvider`, so without this the mode
 * switch would be a no-op.
 */
export function bare<P extends object>(Page: ComponentType<P>): ComponentType<P> & { bare: true } {
  function Bare(props: P) {
    return (
      <ModeProvider>
        <Page {...props} />
      </ModeProvider>
    );
  }
  return Object.assign(Bare, { bare: true as const });
}
