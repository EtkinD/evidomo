import type { NextPage } from 'next';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';
import { FactConflictsView } from '../../../../components/FactConflicts';

const DemoConflictsPage: NextPage = () => (
  <DemoRunFrame
    title="Fact conflicts"
    widthClass="max-w-4xl"
    loadingLabel="Loading the fact conflicts…"
  >
    {(runId) => <FactConflictsView key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoConflictsPage;
