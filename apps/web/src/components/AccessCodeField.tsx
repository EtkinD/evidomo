import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { readStoredAccessCode } from '../lib/access-code';
import { Field } from './FormField';

const subscribeNever = (): (() => void) => () => undefined;

/**
 * The access code of a metered action (start a run, resume a failed one): what the user typed,
 * else the code remembered for this browser session.
 */
export function useAccessCode(): { code: string; setCode: (value: string) => void } {
  const [typed, setTyped] = useState<string | null>(null);
  // The server snapshot is empty, so hydration matches; the stored code appears right after.
  const stored = useSyncExternalStore(subscribeNever, readStoredAccessCode, () => '');
  return { code: typed ?? stored, setCode: setTyped };
}

export function AccessCodeField({
  code,
  onChange,
  error,
}: {
  code: string;
  onChange: (value: string) => void;
  /** Set when the server refused the code. */
  error: string | undefined;
}) {
  const t = useTranslations('readiness');
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <Field id={id} label={t('accessCode')} hint={t('accessCodeHint')} error={error}>
      {(control) => (
        <div className="join w-full sm:max-w-sm">
          <input
            {...control}
            type={show ? 'text' : 'password'}
            className={`input join-item min-h-11 w-full ${error === undefined ? '' : 'input-error'}`}
            value={code}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
          <button
            type="button"
            className="btn join-item min-h-11"
            aria-pressed={show}
            onClick={() => setShow((value) => !value)}
          >
            <span aria-hidden>{show ? t('hide') : t('show')}</span>
            <span className="sr-only">{show ? t('hideCode') : t('showCode')}</span>
          </button>
        </div>
      )}
    </Field>
  );
}
