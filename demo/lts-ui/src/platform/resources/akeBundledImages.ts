import manifest from './akeImageManifest.json';

type ImageVariant = { path: string; width: number; height: number };
type BundledImage = ImageVariant & { thumbnail?: ImageVariant };
const images: Record<string, BundledImage> = manifest.images;
const bundledPaths = new Map(Object.values(images).map(image => [image.path, image]));
const unavailable = new Set(manifest.unavailable);

/** Also accept paths already normalized by the public asset resolver. */
export function getBundledAkeImage(source: string): BundledImage | undefined {
  if (images[source]) return images[source];
  if (/^(?:[a-z]+:)?\/\//i.test(source) || /^(?:blob|data|file):/i.test(source)) return undefined;
  const path = source.match(/(?:^|\/)(assets\/ake-icons\/[^/]+\.webp)$/)?.[1];
  return path ? bundledPaths.get(path) : undefined;
}
export function isUnavailableAkeImage(source: string): boolean {
  return unavailable.has(source);
}
