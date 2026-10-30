import { APPROVED_IMAGES, useAssetManifest, type ApprovedImageKey } from '../assets';
import { AssetFigure, NotGenerated, ShowcaseShell } from '../ui';

function Images() {
  const query = useAssetManifest();
  if (query.isPending) {
    return (
      <div role="status" className="flex items-center gap-2 text-base-content/70">
        <span className="loading loading-spinner loading-sm" aria-hidden />
        Loading images
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="alert alert-error">
        <span>The image manifest could not be loaded.</span>
      </div>
    );
  }
  if (query.data.status === 'invalid') {
    return (
      <div role="alert" className="alert alert-error">
        <span>manifest.json does not match the expected shape: {query.data.message}</span>
      </div>
    );
  }
  const items = query.data.status === 'ready' ? query.data.manifest.items : [];
  const keys = Object.keys(APPROVED_IMAGES) as ApprovedImageKey[];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {keys.map((key) => {
        const item = items.find((candidate) => candidate.id === APPROVED_IMAGES[key].id);
        return item === undefined ? (
          <NotGenerated key={key} what={APPROVED_IMAGES[key].id} className="min-h-40" />
        ) : (
          <AssetFigure key={key} item={item} />
        );
      })}
    </div>
  );
}

export function ImageryPage() {
  return (
    <ShowcaseShell title="Imagery">
      <section aria-labelledby="images-title" className="flex flex-col gap-3">
        <h2 id="images-title" className="text-xl font-semibold">
          The four approved images <code className="font-mono text-base">H-IMG-1</code>
        </h2>
        <Images />
      </section>
    </ShowcaseShell>
  );
}
