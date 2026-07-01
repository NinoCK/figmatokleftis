/**
 * JSON / base64 / clipboard encoding utilities.
 *
 * Handles serialization of capture trees to JSON with base64-encoded
 * asset blobs, and wrapping the result for clipboard transport.
 */

import type { AssetEntry, Base64Asset, CaptureTree } from './types.js';

/**
 * Convert a Uint8Array to a data-URL string via FileReader.
 */
export async function uint8ArrayToDataUrl(data: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = Object.assign(new FileReader(), {
      onload: () => resolve(reader.result as string),
      onerror: () => reject(reader.error),
    });
    reader.readAsDataURL(
      new File([data as BlobPart], "", { type: "application/octet-stream" })
    );
  });
}

/**
 * Convert a Blob to a plain object containing its MIME type and a
 * base64-encoded data-URL representation.
 */
export async function blobToBase64Object(blob: Blob | null | undefined): Promise<Base64Asset | null> {
  if (blob == null) return null;

  const arrayBuffer = await blob.arrayBuffer();
  const dataUrl = await uint8ArrayToDataUrl(new Uint8Array(arrayBuffer));

  return {
    type: blob.type,
    base64Blob: dataUrl,
  };
}

/**
 * Serialize a capture tree to a JSON string, converting every asset
 * blob to a base64 object along the way.
 */
export async function treeToJson(tree: CaptureTree): Promise<string> {
  const serializedAssets: Record<string, Omit<AssetEntry, 'blob'> & { blob: Base64Asset | null }> = {};

  for (const [key, asset] of tree.assets.entries()) {
    serializedAssets[key] = {
      ...asset,
      blob: await blobToBase64Object(asset.blob),
    };
    // Drop the raw blob once encoded so peak memory doesn't hold blob + base64
    // for every asset at once (large image-heavy pages otherwise page to disk).
    asset.blob = null;
  }

  return JSON.stringify({
    ...tree,
    assets: serializedAssets,
    fonts: tree.fonts,
  });
}

/**
 * Wrap a JSON string for clipboard transport by base64-encoding it and
 * embedding it inside HTML comment markers that the paste
 * handler can recognise.
 */
export async function wrapForClipboard(jsonString: string): Promise<Blob> {
  const dataUrl = await uint8ArrayToDataUrl(
    new TextEncoder().encode(jsonString)
  );
  const base64Payload = dataUrl.slice(dataUrl.indexOf(",") + 1);

  const openTag = "<!--(figh2d)";
  const closeTag = "(/figh2d)-->";
  const html =
    '<span data-h2d="' + openTag + base64Payload + closeTag + '"></span>';

  return new Blob([html], { type: "text/html" });
}
