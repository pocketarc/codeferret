The skill you are about to load assumes a running application. This session has none: no
dev server, no `/_next/mcp` endpoint, no build output and no bundle to analyse. Read the
skill for what it knows about Next.js, not for its workflow.

- Do not run `next dev`, `next build`, `next experimental-analyze`, or any other command
  that writes into the checkout. Every lens in this review is reading that same tree at
  once, and a build writes into `.next/`, which the diff's pathspec excludes, so the writes
  would be invisible rather than absent.
- Skip the whole of `debug-tricks.md`. Its first half posts JSON-RPC to a dev server's
  `/_next/mcp`, and there is no server and no port to find; its second half runs
  `next build --debug-build-paths`. Do not go looking for either with `curl`.
- Skip the Bundle Analysis section of `bundling.md` and the Debugging step of
  `hydration-error.md`. Both need a rendered page or an interactive analyser.

What the source settles on its own is the whole of your scope, and it is most of the skill:
the server and client boundary and what crosses it, `async` `params`, `searchParams`,
`cookies()` and `headers()`, the `"use client"` and `"use server"` directives, file
conventions and route structure, the choice between a route handler and a Server Action,
metadata, `next/image`, `next/font` and `next/script`, a `useSearchParams` outside a
`Suspense` boundary, caching and revalidation options, and the source-level causes of a
hydration mismatch.

Say in `notes` which of the skill's checks needed a running application, so that a reader
can tell what this lens covered from what it could not reach.
