import type { NextPage } from 'next';
import { DemoMonitor } from '../../../components/demo/DemoMonitor';
import { DemoRunFrame } from '../../../components/demo/DemoRunFrame';

const DemoRunPage: NextPage = () => (
  <DemoRunFrame title="Sample run" widthClass="max-w-5xl" loadingLabel="Loading the run…">
    {(runId) => <DemoMonitor key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoRunPage;
