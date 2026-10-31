import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useDemoReplay } from '../../lib/use-demo-replay';
import { RunMonitorView } from '../RunMonitor';
import { ReplayControls } from './ReplayControls';

export function DemoMonitor({ runId }: { runId: string }) {
  const t = useTranslations('demo');
  const [speed, setSpeed] = useState(1);
  const { monitor, started, start, restart, finished } = useDemoReplay(runId, speed);
  const controlsRef = useRef<HTMLElement>(null);
  const wasStarted = useRef(false);

  // The start button disappears when pressed: keep keyboard and screen-reader users in place.
  useEffect(() => {
    if (started && !wasStarted.current) controlsRef.current?.focus();
    wasStarted.current = started;
  }, [started]);

  return (
    <RunMonitorView
      monitor={monitor}
      runId={runId}
      controls={
        started ? (
          <ReplayControls
            ref={controlsRef}
            speed={speed}
            onSpeedChange={setSpeed}
            onRestart={restart}
            finished={finished}
          />
        ) : (
          <section
            aria-label={t('controls')}
            className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-box border border-base-300 bg-base-100 p-4"
          >
            <button type="button" className="btn btn-primary min-h-11" onClick={start}>
              {t('start')}
            </button>
            <p className="text-sm text-base-content/70">{t('startHint')}</p>
          </section>
        )
      }
    />
  );
}
