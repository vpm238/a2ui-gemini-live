/**
 * Mint a short-lived Gemini Live token, so a deployed page never holds a key.
 *
 * Cloudflare Pages Function. Set GEMINI_API_KEY as a secret:
 *   wrangler pages secret put GEMINI_API_KEY
 *
 * The browser then connects with `?access_token=<token>` rather than
 * `?key=<key>` — the two use different query parameters and swapping them
 * gets you "Method doesn't allow unregistered callers", which reads like an
 * auth failure and is really a parameter-name failure.
 *
 * Two expiries, and the short one is the surprising one:
 *
 *   expireTime            how long an established session may run  (30 min)
 *   newSessionExpireTime  how long you have to START one           (1 min)
 *
 * So this is minted at the moment the user presses Start. A token handed
 * around, pasted into a chat, or cached for later is already dead.
 */

const MINT_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

export async function onRequestPost({ env }) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY is not set on this deployment' }, 501);
  }

  const now = Date.now();
  const res = await fetch(`${MINT_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      // Pinning the model here means a leaked token cannot be spent on
      // something more expensive than the demo.
      liveConnectConstraints: {
        model: 'models/gemini-3.1-flash-live-preview',
        config: { responseModalities: ['AUDIO'] },
      },
    }),
  });

  if (!res.ok) {
    return json({ error: `Google refused to mint a token (${res.status})` }, 502);
  }

  const { name } = await res.json();
  return json({ token: name, expiresInSeconds: 60 });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
