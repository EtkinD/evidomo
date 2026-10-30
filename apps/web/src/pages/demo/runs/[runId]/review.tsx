import type { NextPage } from 'next';
import { ClaimAuditView } from '../../../../components/ClaimAudit';
import { DemoRunFrame } from '../../../../components/demo/DemoRunFrame';
import { getServerSideProps } from '../../../../lib/i18n-server';

export { getServerSideProps };

const DemoReviewPage: NextPage = () => (
  <DemoRunFrame page="review" widthClass="max-w-6xl">
    {(runId) => <ClaimAuditView key={runId} runId={runId} />}
  </DemoRunFrame>
);

export default DemoReviewPage;
