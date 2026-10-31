# NIX website

Static source for https://core-nix.com, deployed to the `nix` Cloudflare Worker in the Dios account.

## Deploy

Install Node.js and Wrangler v4, sign in with `wrangler login`, then run:

```sh
wrangler deploy --keep-vars
```

Wrangler runs `node scripts/build.mjs` to copy only the page and its assets into `dist/` before upload. The existing `core-nix.com` custom domain is retained. Changes pushed to GitHub are not automatically deployed by this configuration.

Platform icons are from Devicon; their license is in `assets/devicon-LICENSE.txt`.

## Interactive web demo

The prompt opens Author, Wallet, Play, Memories, Desktop, or Terminal. Author saves manuscript chapters in browser local storage and exports plain text. Wallet uses session-only sample funds. The two Play scenes are original canvas mini games, not the commercial titles. The terminal supports a bounded set of workspace commands.

Demo behavior is in `assets/nix-demo.js`; styles are in `assets/nix-demo.css`. No backend or model service is required.

## Pages

The homepage contains the interactive demo and links to `/why`, `/build`, `/architecture`, `/pioneer`, `/pods`, `/memories`, and `/plan`. Each page is a standalone HTML document in its matching directory. Shared navigation styles and mobile menu behavior are in `assets/site.css` and `assets/site.js`. The build packages all eight pages, and Cloudflare serves clean URLs without trailing slashes. Legacy homepage section links redirect to the matching page.

## Paid Pioneer Intent API

Pioneer uses only the authenticated NIX model endpoint. The Worker calls a
private Cloudflare `PioneerAgent` Durable Object and the Workers AI binding;
Cloudflare credentials never go to clients. Existing Authorize.Net purchases,
Intent access tokens, and D1 unit balances remain the billing authority.
Sandbox/test payments do not unlock production inference.

- `GET /intent/v1/account`: paid-token status, available credits, limits.
- `GET /intent/v1/models`: the sole public model alias, `pioneer`.
- `POST /intent/v1/chat/completions`: OpenAI-compatible text and tool calls,
  including SSE adaptation. Requires `Authorization: Bearer INTENT_TOKEN` and
  an `Idempotency-Key` of 16–128 letters, digits, dots, underscores, colons or dashes.
- One bounded request costs one credit; maximum body is 128 KiB, maximum output
  is 4,096 tokens. Completed retries within 30 days reuse the cached result.
  Reusing an ID with different content returns 409. Failed inference refunds
  exactly once. Abandoned pending requests are refunded by the scheduled job.

Apply the additive schema before the first Agent deployment:

```sh
npx wrangler d1 execute nix-ask --remote --file api/pioneer-schema.sql
npx wrangler deploy --keep-vars
```

`npm test` runs the billing/auth/request tests, including real SQLite transactions.
`PIONEER_LIVE_AI=1 node api/pioneer-live-test.mjs` runs the actual Agent and
Cloudflare model with temporary **local** token, subscription and credit fixtures.
It does not create payments or change production billing records. It does use
Cloudflare inference. Preserve existing Worker secrets when deploying.
