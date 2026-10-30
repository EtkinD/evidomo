import { useState } from 'react';
import { useDemoReplay } from '../../lib/use-demo-replay';
import { RunMonitorView } from '../RunMonitor';
import { ReplayControls } from './ReplayControls';

export function DemoMonitor({ runId }: { runId: string }) {
  const [speed, setSpeed] = useState(1);
  const { monitor, restart, finished } = useDemoReplay(runId, speed);
  return (
    <RunMonitorView
      monitor={monitor}
      runId={runId}
      controls={
        <ReplayControls
          speed={speed}
          onSpeedChange={setSpeed}
          onRestart={restart}
          finished={finished}
        />
      }
    />
  );
}
