# Design

Visual system for Tavern (Project Knowledge Board). The source of truth for values is `docs/tavern-design-system.html`. Its "Token export" section prints the exact CSS custom properties. This file records the decisions and the rules for applying them.

## Stance

The category standard for B2B SaaS, executed straight. The quality bar is GitHub (Primer) and Atlassian: dense, utilitarian, accessible. Chosen 2026-10-14 after two direction rounds. Do not add quirks or decorative flourishes, and do not drift back to the previous warm cream, Fraunces and copper look.

## Color

- **Strategy:** restrained. Cool blue-biased neutrals carry the interface, with one electric cobalt accent: light `#2447f5` (hover `#1b37cf`, text `#1f3fe0`), dark `#3a5bff` (hover `#4565ff`, text `#8fa2ff`). It sits between classic link blue and indigo. Saturated enough to be recognizably Tavern, without leaning purple. Changed from a classic blue (`#2557e0`) on 2026-10-14 at the user's request for a more modern, characteristic blue.
- **Cobalt means interactive or selected, and nothing else.** It is used for primary buttons, links, focus, the active tab, the current nav item, selected rows and selected chips.
- **Semantic state** uses its own hues: success (green), attention (amber), danger (red). These never double as accent or decoration.
- **Item types** have fixed hues for the life of the product: external link = cobalt (`--color-type-link-*`), uploaded file = orange (`--color-type-file-*`), internal document = violet (`--color-type-doc-*`). Never reuse them for categories, tags or roles.
- **Roles:** Tenant Owner = solid inverse label. Tenant Admin = neutral label with the building icon. Project Admin = accent label with the shield icon. Maintainer = teal. Member = neutral. Viewer = outline with the eye icon.
- **Token tiers:** primitives (`--gray-*`, `--blue-*`, …) are reference only. Components use semantic tokens only (`--color-surface`, `--color-fg-muted`, `--color-accent-emphasis`, …).
- **Light and dark** are both first-class. Dark is defined in `@media (prefers-color-scheme: dark)` with a `:root:not([data-theme="light"])` guard, and again in `:root[data-theme="dark"]`.
- **Contrast:** body text ≥ 4.5:1 on its surface. Input borders (`--color-border-input`) ≥ 3:1. White text on every `*-emphasis` fill ≥ 4.5:1.

## Typography

- **Faces:** Public Sans for all UI. JetBrains Mono only for URLs, IDs, tokens and code, never as a "technical" costume.
- **Scale:** 12/16, 13/20, 14/20 (base UI), 16/24, 20/28, 24/32 (page title, bold, −1%), 32/40 (display, bold, −2%).
- **Weights:** 400, 500 (controls), 600 (titles, labels), 700 (page titles, wordmark).
- Sentence case everywhere, including buttons, tabs and table headers. No uppercase eyebrows.
- Tabular numerals for tables, counters, dates and file sizes.

## Space, shape, elevation, motion

- **Spacing:** 4px grid (`--space-1` … `--space-11` = 2 … 64px). Tight inside groups, generous between groups.
- **Radius:** 4 (tags, kbd), 6 (controls, default), 8 (panels, cards), 12 (dialogs, palette), full (labels, chips, avatars).
- **Control heights:** 28 (dense tables, toolbars), 32 (default), 40 (sign-in, empty states).
- **Elevation:** panels and cards are flat with a 1px border. `--shadow-md` is for menus, popovers and hovered cards. `--shadow-lg` is for dialogs, toasts and the command palette.
- **Motion:** 100ms for hover and color, 160ms for toggles, 240ms ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`) for things that appear. Nothing animates on page load. Animate transform and opacity only. Respect `prefers-reduced-motion`.

## Brand

- The mark is a pushpin seen from the side, which reads as a T: pinning is the product's core gesture, and Tavern is the board teams pin sources to. It replaced the hanging-sign mark on 2026-10-15, chosen from five concepts in `docs/tavern-logo-exploration.html`.
- Construction on a 48-unit grid: a cobalt plate with a 10.5 corner radius (22%). The cap is 24 × 7 at y 9. The body tapers from 10.8 to 7.8 wide over y 16–25.2. The collar is 21 × 4.6. The needle is 2.8 × 11, down to y 40. The glyph is white (`--color-fg-on-emphasis`) on `--color-accent-emphasis`. No effects, outlines, gradients or tilt.
- One-color use drops the plate and draws the pin in the text color. Clear space is a quarter of the mark's width on every side. Minimum size is 16px. Canonical SVG files are `web/public/favicon.svg` and `BrandMark` in `web/src/components/ui.tsx`.
- The wordmark is "Tavern" in Public Sans Bold, −1.5% tracking. The descriptor "Project Knowledge Board" appears only under the wordmark and on the sign-in page.
- Icons come from Lucide at 1.75 stroke: 16px in controls, 14px in metadata, 20px in empty states.

## Component rules

- One primary button per view. Danger buttons stay quiet until hovered. Destructive actions confirm through a dialog that states the access consequence.
- Labels sit above fields and are always visible. An error replaces the hint and names both the problem and the fix.
- Knowledge items always show type icon, title, category, tags, owner and freshness. The pin is shown when pinned. The restriction label is shown only to people allowed to see the rule.
- Actions a role can't perform are omitted, not disabled. The exception is a control disabled with a tooltip that explains a rule the viewer can already see, such as the access matrix.
- Hidden items never appear in lists, counts, activity, search or onboarding. "Not available" copy is the same whether an item exists or not.
- Files are downloadable only in the Clean scan state. Scanning disables download, and Quarantined offers only delete.
- Lists paginate with cursors (Previous/Next or Load more). Numbered pages appear only in the audit log.
- Toasts appear bottom right. Success toasts close after 5s, or 8s when they have an action. Errors stay until dismissed.

## Voice

Plain, specific and calm. Controls name their exact action ("Archive item", "Remove member"). Confirmations state what happens to access and when. Messages never hint at the existence or names of hidden things.
