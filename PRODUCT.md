# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Multi-tenant SaaS used equally by consulting/agency delivery teams (people rotating across several client projects, mixed roles: PM, developer, designer, QA) and in-house product teams sharing project knowledge internally. Core scene: a new member accepts an invitation and needs to find the authoritative links, files, and documents for their role without asking around; admins govern who sees what.

## Product Purpose

Tavern (descriptor: Project Knowledge Board) is one central portal per project that consolidates external links, uploaded files, and internal documents, plus role-relevant onboarding checklists and membership. Success: shorter time from invitation to first useful resource, higher onboarding completion, and zero leakage across tenants, projects, or restricted items.

## Positioning

Not a wiki, not a link dump: a governed index of a project's sources of truth. Every item carries an owner, freshness, and a role-scoped visibility rule; access is explicit per project and revoked instantly. It points to Jira, GitHub, Figma, etc. rather than replacing them.

## Operating Context

Hierarchy: Tenant → Workspace → Project → Knowledge Item. Default roles: Tenant Owner, Tenant Admin, Project Admin, Maintainer, Member, Viewer (one role per project). Item types: external_link, uploaded_file, internal_document (Markdown). Files pass malware scanning (pending / clean / quarantined / failed). Invitations have expiry, use limits, and states (active, revoked, expired, accepted, exhausted). Audit log records actor, action, target, timestamp, outcome. Responsive desktop/tablet/mobile.

## Capabilities and Constraints

MVP: email/password + Google login, tenant switching, workspaces/projects, knowledge hub with search/filter/sort/categories/tags/pin/archive, item-level role restrictions that only narrow access, invitation links, onboarding checklists, audit log. Hidden items are omitted, never shown as locked placeholders. Archive is preferred over permanent deletion. Future (not MVP): SSO/SCIM, custom roles, version history, integrations, AI search, billing.

## Brand Commitments

Name: Tavern. Descriptor: Project Knowledge Board. User asked for a clean, modern look that does not read as AI-generated.

Visual stance (chosen 2026-10-14, after two direction rounds): the category standard for B2B SaaS, executed straight and without quirk. Quality bar: GitHub (Primer) and Atlassian: dense, utilitarian, accessible enterprise UI. Accent: electric cobalt (a modern, characteristic blue; changed from classic blue on 2026-10-14).

## Evidence on Hand

Full PRD/SRS (provided by user, not in repo). No customers, testimonials, metrics, or logos exist; do not fabricate them.

## Product Principles

1. Find the right source in seconds: authority, owner, and freshness are always visible.
2. Access is explicit and quiet: restrictions are understandable without revealing hidden things.
3. Reversible by default: archive before delete; destructive actions are confirmed.
4. Same structure everywhere: consistent across tenants, workspaces, and projects.

## Accessibility & Inclusion

WCAG 2.2 AA for core journeys; full keyboard operation, visible focus, accessible labels, meaningful empty and error states.
