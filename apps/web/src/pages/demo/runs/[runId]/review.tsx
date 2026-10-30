import type { NextPage } from 'next';
import { ClaimAuditView } from '../../../../components/ClaimAudit';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';

const DemoReviewPage: NextPage = () => (
  <DemoRunFrame title="Pack review" widthClass="max-w-6xl" loadingLabel="Loading the review…">
    {(runId) => <ClaimAuditView key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoReviewPage;
