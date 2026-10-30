import type { NextPage } from 'next';
import { DemoMonitor } from '../../../components/demo/DemoMonitor';
import { DemoRunFrame } from '../../../components/demo/DemoRunFrame';
import { getServerSideProps } from '../../../lib/i18n-server';

export { getServerSideProps };

const DemoRunPage: NextPage = () => (
  <DemoRunFrame page="monitor" widthClass="max-w-5xl">
    {(runId) => <DemoMonitor key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoRunPage;
