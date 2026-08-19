# Color Haven

A relaxing paint-by-numbers paper-art game. Fill numbered regions with their
assigned palette colors and complete illustrations — no timer, no way to lose.

## Run

```
node server.js [port]    # default 8080, then open http://localhost:8080
```

Zero dependencies; Three.js is vendored in `vendor/`.

## Test

```
npm test                                   # rules engine unit tests
node server.js 8091 &                      # then, against the running server:
BASE=http://localhost:8091 node test/server.smoke.mjs
```

The server writes runtime state (saves, leaderboards) to `data/`, which is
git-ignored.

## Dev hooks

- `?autostart=practice|daily|journey|learn|selftest` — jump straight into a
  round; `selftest` plays a scripted full round to the results screen.
- `?screen=settings|help|journey|pause` — open any overlay directly
  (screenshot validation).
