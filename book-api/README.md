# book-api

An Express API

## Quick start

```sh
npm install        # creates package-lock.json, commit it
npm run dev        # http://localhost:3000/healthz
npm run check      # typecheck + lint + tests
```

Configuration is read from environment variables and validated at startup (see `.env.example` and `src/config.ts`).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run with reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run check` | Typecheck, lint, and test |

## Docker

```sh
docker build -t book-api .
docker run --rm -p 3000:3000 book-api
```

The image is multi-stage, runs as the unprivileged `node` user, includes only production dependencies, and has a health check.

## Security defaults

- `helmet` security headers, `x-powered-by` disabled, JSON bodies capped at 100 kB
- Errors never leak stack traces or internals to clients
- Environment validated with `zod`; the process refuses to start on bad config
- Graceful shutdown on `SIGTERM`/`SIGINT`

Not included yet (add what your service needs): authentication, rate limiting, and CORS.

Licensed under the MIT License.
