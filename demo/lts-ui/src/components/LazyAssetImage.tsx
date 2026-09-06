import React, { useEffect, useRef, useState } from 'react';
import { normalizeAssetUrl, resolvePublicPath } from '../utils/assetResolver';
import { getBundledAkeImage, isUnavailableAkeImage } from '../platform/resources/akeBundledImages';

function responsiveSources(url: string) {
  const image = getBundledAkeImage(url);
  if (!image?.thumbnail) return undefined;
  return `${resolvePublicPath(image.thumbnail.path)} ${image.thumbnail.width}w, ${resolvePublicPath(image.path)} ${image.width}w`;
}

const loaded = new Set<string>();
const warming = new Set<string>();
const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;
function remember(url: string) {
  loaded.add(url);
  if (loaded.size > 1024) loaded.delete(loaded.values().next().value!);
}
function observe(element: Element, load: () => void) {
  if (typeof IntersectionObserver === 'undefined') { load(); return () => {}; }
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      const start = waiting.get(entry.target);
      waiting.delete(entry.target); observer?.unobserve(entry.target); start?.();
    }
  }, { rootMargin: '120px' });
  waiting.set(element, load); observer.observe(element);
  return () => { waiting.delete(element); observer?.unobserve(element); };
}

/** Warm just the first choices when the user focuses or points at a picker. */
export function warmAssetImages(paths: readonly (string | undefined)[]) {
  for (const path of paths.slice(0, 12)) {
    const url = normalizeAssetUrl(path);
    if (!url || isUnavailableAkeImage(path ?? '') || loaded.has(url) || warming.has(url)) continue;
    warming.add(url);
    const image = new Image(); image.decoding = 'async';
    image.onload = () => { warming.delete(url); remember(url); };
    image.onerror = () => { warming.delete(url); };
    const sources = responsiveSources(url);
    if (sources) { image.sizes = '64px'; image.srcset = sources; }
    image.src = url;
  }
}

/** Text/layout render immediately; offscreen selector images start on intersection. */
export function LazyAssetImage({ src, alt = '', sizes = '64px', srcSet, onLoad, onError, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const url = normalizeAssetUrl(src);
  const ref = useRef<HTMLImageElement>(null);
  const [requested, setRequested] = useState(() => loaded.has(url) ? url : null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!url || !ref.current || requested === url) return undefined;
    if (loaded.has(url)) { setRequested(url); return undefined; }
    return observe(ref.current, () => setRequested(url));
  }, [requested, url]);
  if (failed === url || isUnavailableAkeImage(src ?? '')) return <span className={props.className} role="img" aria-label={alt}
    style={{ ...props.style, display: 'grid', placeItems: 'center', fontSize: 12 }}>{alt.slice(0, 2)}</span>;
  return <img {...props} ref={ref} alt={alt} src={requested === url ? url : undefined}
    sizes={sizes} srcSet={requested === url ? srcSet ?? responsiveSources(url) : undefined}
    data-asset-state={requested === url ? 'requested' : 'deferred'} decoding="async"
    onLoad={event => { remember(url); onLoad?.(event); }}
    onError={event => { setFailed(url); onError?.(event); }} />;
}

if (import.meta.hot) import.meta.hot.dispose(() => { observer?.disconnect(); waiting.clear(); });
