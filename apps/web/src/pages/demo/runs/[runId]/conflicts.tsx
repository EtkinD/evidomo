import type { NextPage } from 'next';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';
import { getServerSideProps } from '../../../../lib/i18n-server';

export { getServerSideProps };
import { FactConflictsView } from '../../../../components/FactConflicts';

const DemoConflictsPage: NextPage = () => (
  <DemoRunFrame page="conflicts" widthClass="max-w-4xl">
    {(runId) => <FactConflictsView key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoConflictsPage;
