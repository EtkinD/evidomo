import type { NextPage } from 'next';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';
import { PackViewer } from '../../../../components/PackViewer';
import { useExportManifest } from '../../../../lib/pack';

function DemoPack({ runId }: { runId: string }) {
  const query = useExportManifest(runId);
  return <PackViewer query={query} runId={runId} />;
}

const DemoPackPage: NextPage = () => (
  <DemoRunFrame title="Listing pack" widthClass="max-w-4xl" loadingLabel="Loading the pack…">
    {(runId) => <DemoPack key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoPackPage;
