# Color Haven

A relaxing paint-by-numbers paper-art game. Fill numbered regions with their
assigned palette colors and complete illustrations — no timer, no way to lose.

A StarHermit engine script game (engine 1.16.1): `native/*.ts` on the
unchanged rules and content in `js/`, played natively by the StarHermit client
and in browsers by the engine's web runtime. See `spec.md`.

## Run

```
starhermit .                 # natively (STARHERMIT: the 1.16.1 runtime)
npm run package              # web loader index.html + starhermit-files.json
node server.js 8080          # serve the folder, then open http://localhost:8080
```

Run `npm run package` after every change (and `npm run css` after editing
`tools/ui-style.css`, `npm run plays` after a content change).

## Test

```
npm test                     # rules, save model, i18n, then tsc, starhermit check and the play scripts
npm run test:browser         # the packaged loader in headless Chrome (desktop, phone, landscape)
node server.js 8091 &        # then, against the running server:
npm run test:server
```

The dev server writes runtime state (saves, leaderboards) to `data/`, which is
git-ignored and not part of the package.
