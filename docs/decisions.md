# Product decisions and assumptions

The spec (`project-knowledge-board-full-specification.md` v1.0) leaves 15 open
questions and marks several defaults "Needs approval". Per §19.10, each one is
written down here and made configurable where possible, rather than silently
hard-coded. Change any of them by editing the referenced setting.

## Open questions (§2) — what the MVP does today

| # | Question | MVP behaviour | Where |
|---|---|---|---|
| 1 | Who can create projects? | Tenant Owner and Tenant Admin only (matches the §3.3 matrix). The creator becomes the project's first Project Admin. | `authz/policy.ts` `tenantCan('project.create')` |
| 2 | One email in several tenants? | Yes. One account, many tenant memberships; every request is scoped by URL. | schema |
| 3 | Restrict invitations by domain? | Yes, optional per invitation (`allowedDomain`). Requires a verified email to accept. | `modules/invitations.ts` |
| 4 | Single- or multi-use invitations? | Single-use by default; 1–500 uses configurable per link. Email-restricted links are always single-use. | `config.invitations.defaultMaxUses` |
| 5 | Default invitation expiry | 7 days (1–30 selectable). | `INVITE_DEFAULT_EXPIRY_DAYS` |
| 6 | Upload size, types, quota | 25 MB per file; pdf, png, jpg/jpeg, gif, webp, txt, md, csv, json, docx, xlsx, pptx. SVG, HTML and executables are blocked. 2 GB per tenant. **Needs approval.** | `config.uploads`, `UPLOAD_MAX_BYTES`, `TENANT_STORAGE_QUOTA_BYTES` |
| 7 | Markdown or rich text? | Markdown, rendered client-side and sanitized with DOMPurify. | `web/src/components/Markdown.tsx` |
| 8 | Export internal documents? | Not in MVP. | — |
| 9 | Who sees audit logs? | Project Admins see their project's log. Tenant Owners/Admins see tenant-level events only (`project_id IS NULL`). | `modules/audit-logs.ts` |
| 10 | Retention for archived projects / deleted tenants | Not automated yet. Archived items and projects are kept indefinitely; permanent item deletion is admin-only and two-step (archive first). **Needs a policy.** | — |
| 11 | Cloud provider / region | Not chosen. Storage is behind a small driver (`modules/files.ts`); local disk in development stands in for private S3-compatible storage. | — |
| 12 | Billing / usage limits | Not in MVP. Only the tenant storage quota is enforced. | — |
| 13 | Can Project Admins invite people outside the tenant? | Yes by default: accepting a project invitation also adds the person to the tenant as a Member. Tenant admins can switch this off per tenant. | `tenants.project_invites_add_tenant_members` |
| 14 | Hide restricted items or show a locked row? | Hidden entirely — from lists, search, counts, tags, recent activity, onboarding links and direct URLs (404). | `modules/knowledge-access.ts` |
| 15 | One role per project? | Exactly one (unique `project_id, user_id`). | schema |

## Roles and permissions (RBAC tables)

Added 2026-10-15 at the user's request. The spec's MVP lists "default roles only"
and puts custom roles and a policy builder in a later phase. This keeps the fixed
role set (no new roles can be created) but makes **what each role can do**
customizable, per organization and per project. The four old project "Policy"
switches became cells of the project table and were migrated
(`migrations/002_role_permissions.sql`).

| Where | Who can edit | Who can read |
|---|---|---|
| Sidebar Organization, then Settings, then the Roles & permissions tab (`/t/:id/settings/roles`) | Owner only | Every organization member. It's the only Settings tab plain members see. |
| Project tab Roles & permissions (`/p/:id/roles`) | Project Admin only | Every project member |

Both tables highlight the viewer's own role column ("You").

**Guard rails.** These are enforced by the server in `normalize*Permissions` and `projectCan` / `tenantCan`; the UI only mirrors them.

- The Owner and the Project Admin always hold every capability, so nobody can lock themselves out.
- Anything that changes who has access cannot be delegated. That covers members and roles, invitations, project settings and archiving, and the tables themselves. These stay Project Admin-only, or Owner-only for transferring ownership and editing the organization table.
- Anyone else given "Manage members" in an organization can manage plain members only. They can never make anyone an Admin.
- Viewers are read-only by definition. Only "View activity log" can be granted to them.
- Dependencies are applied automatically:
  - Delete needs Archive.
  - Pin and Restrict need some edit right.
  - Organization capabilities that live on the settings page need "Open organization settings".
- Item-level restrictions still only narrow what the table grants. A non-admin who can restrict items can tighten restrictions but never loosen them.
- Every change is audited with a per-cell diff (`project.permissions_changed`, `tenant.permissions_changed`). It applies on the next request, because there is no authorization cache.

**Defaults** match the spec's §3.3 matrix:

| Project capability | Maintainer | Member | Viewer |
|---|---|---|---|
| Add knowledge | yes | yes | no |
| Edit items | all | own | none |
| Pin, restrict, manage categories, configure onboarding | yes | no | no |
| Archive and restore | yes | no | no |
| Delete permanently | no | no | no |
| View activity log | no | no | no |

Organization defaults: Admins have every delegable capability; Members have none.

## Other choices worth knowing

- **Tenant admins and project metadata.** Tenant Owners/Admins can list every
  project's *name and status* (tenant-level metadata) so they can manage
  workspaces. They still get a 404 on project content unless they are project
  members. No break-glass access exists.
- **Concealment.** A resource the caller may not see returns `404`, never `403`,
  so its existence isn't revealed. `403` is used only when the caller can already
  see the resource but not perform the action.
- **Sessions.** Server-side sessions in an HttpOnly, SameSite=Lax cookie, plus a
  per-session CSRF token sent as `x-csrf-token` on every mutation, plus an Origin
  check. Roles are re-read from the database on every request, so role changes
  and removals take effect immediately (no authorization cache).
- **Google accounts.** A Google sign-in is linked to an existing account
  automatically only when *both* the Google email and the existing account's
  email are verified. Otherwise the user must sign in with their password and
  connect Google from Account settings. This prevents pre-registration takeover.
- **Malware scanning.** The built-in scanner detects the EICAR signature and
  executable content, and checks file contents against the extension. Production
  should add ClamAV or a cloud scanner behind `scanBuffer()`. Files are never
  downloadable until the scan says `clean`.
- **Email.** No provider is wired up. In development, `email_outbox` is the
  test sink (Account menu, then Dev mailbox). Production needs a sending worker.
- **Last Project Admin.** You cannot demote or remove the last active Project
  Admin of a project, and you cannot remove a tenant member who is the only
  admin of any project.
- **Archived workspace or project.** Read-only for everyone. Mutations return
  `409 READ_ONLY`, and invitations to it stop working.
- **Onboarding configuration** lives in project Settings → Onboarding steps. Project Admins and Maintainers can edit it, and Maintainers see only that section of Settings. The "Getting started" checklist applies to everyone in the project. Role-specific checklists are optional extras.
- **Tag picker** suggests tags from items the person can see, including archived items for roles allowed to view archived content (`GET /projects/:id/tags?scope=all`). New tags are created on save.
- **Add from organization** (project Members, then Add from organization) searches the organization's active members who aren't on the project yet, by name or email. Project Admins can pick several people at once and give them one role. The server accepts only user IDs that belong to the same organization (`GET /projects/:id/member-candidates`, `POST /projects/:id/members` with `userIds`).
- **Document history:** every save of an internal document keeps a version (the newest 50 per document). Anyone who can see the document can read its history. Anyone who can edit it can restore a version, which creates a new version.
- **View as:** Project Admins can preview a project as Maintainer, Member or Viewer. The server applies the previewed role to every read (`x-preview-role` header) and refuses all changes while previewing.
- **CSV:** the audit log (project and organization) and project links export as CSV. Cells that start with `= + - @` are escaped against formula injection. Link import takes up to 500 rows. It skips invalid rows and links the importer can already see in the project. It creates missing categories only for roles that can manage categories.
- **Storage:** 2 GB per organization, plus a service-wide ceiling (`STORAGE_TOTAL_LIMIT_BYTES`, default 9 GB) that keeps Cloudflare R2 inside its free tier. Usage is shown in organization settings.
- **Onboarding due dates** are relative ("within N days of joining"), so they work for anyone who joins later.
- **Duplicate project** copies categories, role permissions and onboarding, and optionally links and documents (with tags, pins and access rules). It never copies members or uploaded files.
