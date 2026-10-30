import type { NextPage } from 'next';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';
import { getServerSideProps } from '../../../../lib/i18n-server';

export { getServerSideProps };
import { PackViewer } from '../../../../components/PackViewer';
import { useExportManifest } from '../../../../lib/pack';

function DemoPack({ runId }: { runId: string }) {
  const query = useExportManifest(runId);
  return <PackViewer query={query} runId={runId} />;
}

const DemoPackPage: NextPage = () => (
  <DemoRunFrame page="pack" widthClass="max-w-4xl">
    {(runId) => <DemoPack key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoPackPage;
