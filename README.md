# Tavern — Project Knowledge Board

A multi-tenant portal that gives each project one place for its links, files,
internal documents, members and onboarding. Built from
`project-knowledge-board-full-specification.md` (v1.0) as the MVP scope.

- **API:** Fastify 5 + TypeScript, PostgreSQL 17 (`server/`)
- **Web:** React 19 + Vite + TanStack Query (`web/`)
- **Docs:** product assumptions for the spec's open questions are in [`docs/decisions.md`](docs/decisions.md)

## Run it locally

Requires Node 22+ and Docker.

```bash
npm install
npm run db:up        # Postgres on localhost:54329
npm run seed         # migrations + demo data (add -- --reset to start over)
npm run dev          # API on :4000, web on http://localhost:5173
```

Demo accounts (password `tavern-demo-pass`, development only):

| Email | What they show |
|---|---|
| alice@acme.test | Tenant Owner and Project Admin of *Atlas Mobile App* and *Billing Revamp* |
| bob@acme.test | Maintainer on Atlas, Member on Billing |
| carol@acme.test | Member on Atlas — can't see the restricted runbook |
| dave@acme.test | Viewer on Atlas — read-only |
| erin@acme.test | Tenant Admin with **no** project memberships — manages people, can't read content |
| frank@globex.test | A different tenant entirely — sees none of Acme |

In development, emails (verification, password reset, invitations) go to
**Account menu → Dev mailbox** instead of being sent.

Google sign-in turns on when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in `.env`.
The redirect URI to register is `http://localhost:5173/api/v1/auth/google/callback`.

## Tests

```bash
npm test             # vitest against a throwaway tavern_test database
npm run typecheck
```

The suite covers the permission matrix exhaustively, plus the §10 acceptance
criteria: tenant isolation by ID substitution, project membership, viewer
read-only, item visibility in search and counts, invitation expiry and
concurrency, immediate revocation, file quarantine, Google state validation,
and audit logging.

## How it's put together

```
server/
  migrations/001_init.sql     schema — composite FKs stop cross-tenant references in the DB itself
  src/authz/policy.ts         the permission matrix (§3.3) and item rules (§3.4) as pure functions
  src/authz/context.ts        per-request access loaders: tenant + project membership + role, re-read every request
  src/modules/knowledge-access.ts  SQL visibility predicate shared by lists, search, counts, tags, onboarding
  src/modules/*.ts            one file per domain: tenants, projects, members, invitations, knowledge, files, onboarding, audit-logs
  src/auth/                   email/password (Argon2id), sessions, CSRF, Google OAuth (code + PKCE + state + nonce)
web/src/
  pages/                      auth, setup wizard, dashboard, workspaces, search, project/*, tenant settings, account
  components/                 app shell, knowledge rows/tiles, audit log table, UI primitives
```

Security properties, by layer:

- **Every query is scoped.** Project routes resolve access with one join over project, tenant,
  active project membership and active tenant membership. Anything else is a `404`.
- **Visibility is filtered in SQL,** never after the fact, so restricted items don't leak through
  totals, pagination, tag lists or onboarding links.
- **Invitation tokens** are 256-bit random values stored as SHA-256 hashes, shown once, never logged.
  Acceptance runs in one transaction with a row lock, so use limits hold under concurrency.
- **Files** live under `tenants/<tenant>/projects/<project>/<uuid>` with no public URL.
  Uploads and downloads use HMAC-signed, short-lived URLs issued only after an access check.
  Downloads are served as attachments with `nosniff` and a sandbox CSP.
- **Audit log** writes happen in the same transaction as the change. A database trigger makes the
  table append-only. Tokens, passwords, signed URLs and document bodies are never recorded.

## Production notes

`npm run build` builds the SPA. With `NODE_ENV=production` the API serves it from the same
origin (`node server/dist/index.js` after `npm run build -w server`). Set a strong `APP_SECRET`
(32+ chars) and a real `APP_ORIGIN`, and put TLS in front. Before a broad launch, wire up an email
provider, a real malware scanner, and private object storage — see `docs/decisions.md`.
