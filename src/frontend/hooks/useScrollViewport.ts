// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from 'react';

export function useScrollViewport(defaultHeight = 800) {
  const scrollRef = useRef(null);
  const frameRef = useRef(0);
  const scheduledElementRef = useRef(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: defaultHeight });

  const read = useCallback((element = scrollRef.current) => {
    if (!element) return;
    const next = {
      scrollTop: Math.round(element.scrollTop || 0),
      height: element.clientHeight || defaultHeight
    };
    setViewport((current) => (
      current.scrollTop === next.scrollTop && current.height === next.height ? current : next
    ));
  }, [defaultHeight]);

  const schedule = useCallback((element = scrollRef.current) => {
    if (!element) return;
    scheduledElementRef.current = element;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const nextElement = scheduledElementRef.current;
      scheduledElementRef.current = null;
      read(nextElement);
    });
  }, [read]);

  const onScroll = useCallback((event) => {
    schedule(event.currentTarget);
  }, [schedule]);

  useEffect(() => {
    read();
    const element = scrollRef.current;
    if (!element) return undefined;
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => schedule(element))
      : null;
    resizeObserver?.observe(element);
    const handleResize = () => schedule(element);
    window.addEventListener('resize', handleResize);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      scheduledElementRef.current = null;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [read, schedule]);

  return { scrollRef, viewport, onScroll };
}

export { buildVirtualRange, buildFixedVirtualRange, lowerBound } from '../lib/ui-utils.js';
