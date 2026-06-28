import { useEffect, useMemo, useState } from 'react';
import { assetRepository } from '../data/repositories.js';

interface ImageBlock {
  type?: string;
  src?: unknown;
}

export function useResolvedImageSources(blocks: ImageBlock[], docId: string | null | undefined): Record<string, string> {
  const imageSources = useMemo(() => (
    [...new Set(blocks.filter((block) => block.type === 'image').map((block) => block.src))]
  ), [blocks]);
  return useResolvedImageSourcesForSources(imageSources, docId);
}

export function useResolvedImageSourcesForSources(imageSources: unknown[] | null | undefined, docId: string | null | undefined): Record<string, string> {
  const normalizedSources = useMemo(() => (
    [...new Set((imageSources || []).map((source) => String(source || '').trim()).filter(Boolean))]
  ), [imageSources]);
  const imageSourcesKey = normalizedSources.join('\n');
  const [resolvedImages, setResolvedImages] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!docId || normalizedSources.length === 0 || !assetRepository.canResolveImageSources()) {
      setResolvedImages({});
      return undefined;
    }

    let alive = true;
    assetRepository.resolveImageSources({ docId, sources: normalizedSources })
      .then((result: unknown) => { if (alive) setResolvedImages((result as Record<string, string> | null | undefined) || {}); })
      .catch(() => { if (alive) setResolvedImages({}); });
    return () => { alive = false; };
  }, [docId, imageSourcesKey]);

  return resolvedImages;
}
