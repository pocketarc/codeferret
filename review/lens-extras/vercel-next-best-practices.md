---
standing-detail: >-
  No application was used, so nothing was judged from a build, a bundle or a rendered
  page.
---

The skill you are about to load assumes a running application. Do not use one, whatever this
checkout holds. `/codeferret:review` runs against a developer's own tree, where a dev server
is often up on a port and `.next/` is often full, so the workflow the skill describes may be
available to you and is still not yours to run. Read the skill for what it knows about
Next.js, not for its workflow. Every finding you make comes from source.

- Do not run `next dev`, `next build`, `next experimental-analyze`, or any other command
  that writes into the checkout. Every lens in this review is reading that same tree at
  once, and a build writes into `.next/`, which the diff's pathspec excludes, so the writes
  would be invisible rather than absent.
- Skip the whole of `debug-tricks.md`. Its first half posts JSON-RPC to a dev server's
  `/_next/mcp`, and its second half runs `next build --debug-build-paths`. Do not go looking
  for a port with `curl`, and do not use one you find.
- Skip the Bundle Analysis section of `bundling.md` and the Debugging step of
  `hydration-error.md`. Both need a rendered page or an interactive analyser.

Your scope is everything in the skill except what the bullets above take out, which is most
of it. Start with the server and client boundary and what crosses it, `async` `params`,
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
