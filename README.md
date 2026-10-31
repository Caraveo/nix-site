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
