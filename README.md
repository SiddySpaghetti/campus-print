# CampusPrint

Students pick a campus print shop, upload a document, choose print options and
collect the prints when the shop marks them ready. Shops with online payment
switched on take Razorpay into the shop's own account; every other shop is
pay-at-counter.

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (Auth,
Postgres, Storage) · deployed on Vercel from `main`.

## Run locally

```bash
cp .env.example .env.local   # fill in the values (names only are committed)
npm install
npm run dev                  # http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` | ESLint |
| `npm run test:security` | Node test runner: validation, auth helpers, webhook, flow logic, source hygiene |
| `npx tsc --noEmit` | Type check |

## Environment

See `.env.example`. `NEXT_PUBLIC_*` values are public (Supabase URL and
publishable key). `SUPABASE_SERVICE_ROLE_KEY` and the `RAZORPAY_*` secrets are
server-only and must never get a `NEXT_PUBLIC_` prefix. On Vercel,
`VERCEL_PROJECT_PRODUCTION_URL` (set automatically) is used for canonical and
social-sharing URLs.

## Layout

```
app/                     routes
  page.tsx               landing (public)
  login/, auth/          magic link + Google OAuth, callback, POST-only sign-out
  start-printing/        student print flow: shop → upload → options → review → track
  (student)/             My orders, notifications
  shop/, admin/          shopkeeper queue, read-only admin overview
  api/                   route handlers (uploads, orders, shop status, webhook)
components/
  landing/ flow/ print/  feature UI
  shared/ ui/            headers, layout primitives, buttons, inputs
lib/
  server/                server-only: auth, validation, errors, rate limiting, file inspection
  shops.ts pricing.ts orders.ts  data access and display helpers
utils/supabase/          browser, server, proxy and service-role clients
supabase/migrations/     schema, RLS, functions (source of truth for the database)
tests/                   node:test suites
```

## Conventions

- **Authorise in the handler.** Every route handler starts with
  `requireRole(...)` (`lib/server/auth.ts`); pages call `requireRolePage` /
  `requireStudentPage`. Hidden buttons and `proxy.ts` are not authorisation.
- **The database is the authority.** RLS limits every read; prices, page
  counts and status transitions are computed or checked in Postgres functions.
  The browser never sends a price, total or page count.
- **Service role only on the server**, only after the caller is authorised
  (`utils/supabase/admin.ts`).
- **Untrusted input is validated strictly** (`lib/server/validate.ts`):
  unknown fields rejected, enums exact, UUIDs canonical. Uploaded files are
  re-inspected by their bytes before an order can use them.
- **Errors are generic to the client.** Route handlers go through `handle()`
  (`lib/server/errors.ts`); logs carry an error code and short message, never
  tokens, bodies or personal data. Pages throw on a failed read so
  `app/error.tsx` shows a retry instead of an empty list.
- **Redirect targets** from `?next=` go through `safeNextPath` (same-origin only).
- **Server Components by default**; client components only for interaction
  and motion. Motion respects `prefers-reduced-motion`.
- **Database changes** go in a new file under `supabase/migrations/`. Note:
  `public.public_shops` must stay a security-definer view (the advisor
  warning is expected; switching it breaks the public shop list).

## Known gaps

- Online payment is per shop (`shops.online_payment` plus that shop's own
  `RAZORPAY_*` keys). Refunds are manual: see `docs/refund-reconciliation.md`.
- Notifications are in-app only (no email/SMS).
- Admin is read-only: shop verification and pricing are edited in Supabase.
