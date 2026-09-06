---
standing-detail: >-
  No application was used, so nothing that needs a build or a running server was measured,
  among them bundle size and import chains, per-route output size, which routes were
  prerendered, the server's errors, route map and logs, and whether a custom cache handler
  shares revalidated pages across instances. A
  hydration mismatch was judged from the source causes of one alone, never from comparing
  the server output against the client output on a rendered page.
---

The skill you are about to load assumes a running application. Do not use one, whatever this
checkout holds. `/codeferret:review` runs against a developer's own tree, where a dev server
is often up on a port and `.next/` is often full, so the workflow the skill describes may be
available to you and is still not yours to run. Read the skill for what it knows about
Next.js, not for its workflow. Every finding you make comes from source.

- Do not run `next dev`, `next build`, `next experimental-analyze`, or any other command
  that writes into the checkout. Every lens in this review is reading that same tree at
  once, and a build does not stop at `.next/`, which the diff's pathspec excludes. It also
  rewrites `next-env.d.ts` at the project root, which `exclude-paths` does not cover, on
  purpose: a hand edit there is a finding worth making, and a build overwrites it before any
  lens could report it, landing the rewrite in the diff the others are reading. Under
  `output: 'export'` a build
  writes `out/` as well, which the default pathspec excludes at the repository root and under
  `apps/*` and `packages/*`, and elsewhere only for `_next/`, `.html` and `.txt`, so for an
  application rooted anywhere else its sitemaps, manifests and copied `public/` assets land
  inside the reviewed change.
- Do not start a server, and do not `curl` a port, whether or not you started what is
  listening on it. The bullet above is not enough on its own:
  `node .next/standalone/server.js` names no `next` command and runs no build.
  `self-hosting.md` is in scope for what it holds about `next.config`, so you will meet that
  command there: in a "Testing Cache Handler" section that opens with **Critical**, and in
  its Pre-Deployment Checklist.
- Skip the whole of `debug-tricks.md`. Its first half posts JSON-RPC to a dev server's
  `/_next/mcp`, and its second half runs `next build --debug-build-paths`.
- Skip the Bundle Analysis section of `bundling.md` and the Debugging step of
  `hydration-error.md`. Both need a rendered page or an interactive analyser.
- Do not run a codemod. `npx @next/codemod@latest upgrade` in `file-conventions.md` and
  `npx @next/codemod@latest next-async-request-api .` in `async-patterns.md` both rewrite
  every matching call site across the checkout, which corrupts the diff every other lens in
  this run is reading and, being an `npx` call, fetches and runs code from the network
  besides. A codemod the diff needs is a finding to report, never a command to run.
- Do not run `npm run build`, `pm2 start ecosystem.config.js`, `npx create-sst@latest`, or
  `npx @opennextjs/aws build`. None names `next` on the command line, but each starts a
  build or a server the same way the first two bullets rule out: they are `self-hosting.md`'s
  Pre-Deployment Checklist, its PM2 example, and its OpenNext section. The last one also
  writes `.open-next/`, which the default `exclude-paths` hides, so its writes would be
  invisible rather than absent. `npm run dev`, and its `pnpm dev`, `yarn dev` and `bun dev`
  spellings, are the same case: each one runs `next dev`, which fills `.next/` in the tree
  every other lens is reading. It is also the command you are likeliest to reach for, because
  `create-next-app` writes that script into `package.json`. `npm start` and `next start` are
  out as well. Neither writes a build, so the first bullet does not reach them, but each
  serves one, which is what the second bullet is about.

Your scope is everything in the skill except what the bullets above take out. That leaves
most of it. Start with the server and client boundary and what crosses it, `async` `params`,
`searchParams`, `cookies()` and `headers()`, the `'use client'`, `'use server'` and
`'use cache'` directives, file conventions and route structure, parallel and intercepting
routes and what they need to work (`@slot` directories, a `default.tsx` beside each one,
`(.)` and `(..)` matchers, and closing a modal with `router.back()`), the choice between a
route handler and a Server Action, metadata, `next/image`, `next/font` and `next/script`, a
`useSearchParams` outside a `Suspense` boundary, caching and revalidation options, the
`runtime` a route or layout exports, the `next.config` reads behind `output: 'standalone'`
and a `cacheHandler`, `unstable_rethrow` in a `catch` that would otherwise swallow
`redirect()` or `notFound()`, and the source-level causes of a hydration mismatch. Anything
else the source settles is in scope whether or not it is named here.

Say in `notes` which of the skill's checks needed a running application, so that a reader
can tell what this lens covered from what it could not reach.
