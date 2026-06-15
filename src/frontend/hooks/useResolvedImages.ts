import { useEffect, useMemo, useState } from 'react';
import { assetRepository } from '../data/repositories.js';

export function useResolvedImageSources(blocks, docId) {
  const imageSources = useMemo(() => (
    [...new Set(blocks.filter((block) => block.type === 'image').map((block) => block.src))]
  ), [blocks]);
  return useResolvedImageSourcesForSources(imageSources, docId);
}

export function useResolvedImageSourcesForSources(imageSources, docId) {
  const normalizedSources = useMemo(() => (
    [...new Set((imageSources || []).map((source) => String(source || '').trim()).filter(Boolean))]
  ), [imageSources]);
  const imageSourcesKey = normalizedSources.join('\n');
  const [resolvedImages, setResolvedImages] = useState({});

  useEffect(() => {
    if (!docId || normalizedSources.length === 0 || !assetRepository.canResolveImageSources()) {
      setResolvedImages({});
      return undefined;
    }

    let alive = true;
    assetRepository.resolveImageSources({ docId, sources: normalizedSources })
      .then((result) => { if (alive) setResolvedImages(result || {}); })
      .catch(() => { if (alive) setResolvedImages({}); });
    return () => { alive = false; };
  }, [docId, imageSourcesKey]);

  return resolvedImages;
}
