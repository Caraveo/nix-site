# NIX website

Static source for https://core-nix.com, deployed to the `nix` Cloudflare Worker in the Dios account.

## Deploy

Install Node.js and Wrangler v4, sign in with `wrangler login`, then run:

```sh
wrangler deploy --keep-vars
```

Wrangler runs `node scripts/build.mjs` to copy only the page and its assets into `dist/` before upload. The existing `core-nix.com` custom domain is retained. Changes pushed to GitHub are not automatically deployed by this configuration.

Platform icons are from Devicon; their license is in `assets/devicon-LICENSE.txt`.
