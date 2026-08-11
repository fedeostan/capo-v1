import webpush, { WebPushError } from 'web-push';
import {
  classifyPushStatus,
  type PushOutcome,
  type PushPayload,
} from '@capo/core/channels/push-rules';

// The Web Push transport. Sibling of lib/whatsapp.ts, which does the same job
// for the two routes that talk to Meta: this file owns config and the wire,
// nothing about who gets told what.
//
// Deliberately NOT in packages/core/src/channels/ where the WhatsApp channel
// lives, and this needs saying so a reviewer does not "fix" it: `web-push` is
// a Node-only dependency and @capo/core is the bundle the agent ships in.
// Push never involves a model, so the agent bundle must not acquire Node-only
// machinery it never calls. The pure half of this feature IS in core, at
// channels/push-rules.ts, which is what `pnpm push-check` covers.
//
// Env is read lazily, inside functions — never at module scope. A module-scope
// read breaks `next build` in CI, where these secrets are absent.

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

function vapid(): VapidConfig | null {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

/** Whether push can be sent at all. Every caller checks this first: an
 *  unconfigured deploy (every preview, and production before the keys are
 *  added) must behave as "push is off", never as an error. */
export function pushConfigured(): boolean {
  return vapid() !== null;
}

/** The half of the key pair the browser needs in order to subscribe. Not a
 *  secret, but it travels the same server-only path as the other two so all
 *  three are configured in one place and none is baked in at build time. */
export function vapidPublicKey(): string | null {
  return vapid()?.publicKey ?? null;
}

/**
 * Hand one message to one registration's push service.
 *
 * Never throws: the caller is a loop over other people's phones and one dead
 * handset must not cost the rest their alert. Everything is folded into a
 * PushOutcome, which is the only thing the dispatcher branches on.
 */
export async function sendPush(
  sub: StoredSubscription,
  payload: PushPayload,
): Promise<PushOutcome> {
  const config = vapid();
  if (!config) return 'retry';

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 12 },
    );
    return 'ok';
  } catch (err) {
    // WebPushError carries the push service's own status code, which is the
    // only thing that distinguishes "this phone is gone forever" from "try
    // again later". Anything that is not a WebPushError never reached a push
    // service at all (DNS, socket, a bad payload) — status 0, retryable.
    if (err instanceof WebPushError) return classifyPushStatus(err.statusCode);
    return classifyPushStatus(0);
  }
}
