// Downloading inbound media from the Meta Graph API.
//
// Mirrors ./whatsapp.ts: config is injected by the caller (the webhook reads env
// lazily); this package never touches process.env.
//
// The flow is two hops and each one has a trap:
//   1. GET {base}/{media-id}  → { url, mime_type, file_size, sha256, … }
//   2. GET url                → the bytes
// The url returned by hop 1 points at Meta's CDN but STILL requires the
// Authorization header — a plain fetch(url) returns 401. It is also short-lived
// (~5 minutes) and effectively single-use, so it must be consumed immediately
// and never persisted.

export class WhatsAppMediaError extends Error {}

export interface WhatsAppMediaConfig {
  accessToken: string;
  /** Overridable for tests; defaults to the live Graph API. */
  graphApiBase?: string;
  /** Reject anything larger, before downloading. Defaults to 16 MiB (Meta's own cap). */
  maxBytes?: number;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  /** MIME type with parameters stripped, e.g. 'audio/ogg'. */
  mediaType: string;
  byteLength: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

interface MediaMetadata {
  url?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * "audio/ogg; codecs=opus" → "audio/ogg".
 *
 * The AI SDK file part wants a bare media type. Passing the parameterized
 * string through is a silent-failure class: the provider does not error, it
 * just fails to recognise the format.
 */
export function bareMediaType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export async function downloadMedia(mediaId: string, config: WhatsAppMediaConfig): Promise<DownloadedMedia> {
  const base = config.graphApiBase ?? 'https://graph.facebook.com/v23.0';
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  // Meta's CDN 400s on some default agents; be explicit.
  const headers = { Authorization: `Bearer ${config.accessToken}`, 'User-Agent': 'capo/1.0' };

  // ── hop 1: metadata ──────────────────────────────────────────────────────
  const metaRes = await fetch(`${base}/${mediaId}`, { headers });
  if (!metaRes.ok) {
    throw new WhatsAppMediaError(`media lookup failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const metadata = (await metaRes.json()) as MediaMetadata;
  if (!metadata.url) {
    throw new WhatsAppMediaError(`media lookup returned no url for ${mediaId}`);
  }

  // Free size guard: refuse before spending the download.
  if (typeof metadata.file_size === 'number' && metadata.file_size > maxBytes) {
    throw new WhatsAppMediaError(`media too large (${metadata.file_size} bytes > ${maxBytes})`);
  }

  // ── hop 2: the bytes (same Authorization header — this is the trap) ──────
  const fileRes = await fetch(metadata.url, { headers });
  if (!fileRes.ok) {
    throw new WhatsAppMediaError(`media download failed (${fileRes.status}): ${await fileRes.text()}`);
  }
  const bytes = new Uint8Array(await fileRes.arrayBuffer());

  // Re-check: file_size is advisory and absent on some payloads.
  if (bytes.byteLength > maxBytes) {
    throw new WhatsAppMediaError(`media too large (${bytes.byteLength} bytes > ${maxBytes})`);
  }
  if (bytes.byteLength === 0) {
    throw new WhatsAppMediaError(`media download returned 0 bytes for ${mediaId}`);
  }

  return {
    bytes,
    mediaType: bareMediaType(metadata.mime_type ?? 'application/octet-stream'),
    byteLength: bytes.byteLength,
  };
}
