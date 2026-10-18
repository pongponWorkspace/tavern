// Seed local development data. Run: npm run seed  (add -- --reset to wipe first)
// Every account uses the password below — development only.
import { hash } from '@node-rs/argon2';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { one, pool, query, tx } from './pool.js';

export const SEED_PASSWORD = 'tavern-demo-pass';

const USERS = [
  { key: 'alice', email: 'alice@acme.test', name: 'Alice Tan' },
  { key: 'bob', email: 'bob@acme.test', name: 'Bob Mercer' },
  { key: 'carol', email: 'carol@acme.test', name: 'Carol Ng' },
  { key: 'dave', email: 'dave@acme.test', name: 'Dave Ortiz' },
  { key: 'erin', email: 'erin@acme.test', name: 'Erin Walsh' },
  { key: 'frank', email: 'frank@globex.test', name: 'Frank Ito' },
] as const;

async function main() {
  await migrate(config.databaseUrl, () => {});
  if (process.argv.includes('--reset')) {
    await query(pool, `TRUNCATE users, tenants, email_outbox, audit_logs RESTART IDENTITY CASCADE`);
    console.log('database reset');
  }
  if (await one(pool, `SELECT 1 FROM users WHERE email = 'alice@acme.test'`)) {
    console.log('seed data already present (use --reset to recreate)');
    return;
  }
  const pw = await hash(SEED_PASSWORD);

  await tx(async (db) => {
    const u: Record<string, string> = {};
    for (const x of USERS) {
      u[x.key] = (await one(db, `INSERT INTO users (email, display_name, password_hash, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id`, [x.email, x.name, pw])).id;
    }

    // ── Acme Studio ──
    const acme = (await one(db, `INSERT INTO tenants (name, slug, created_by) VALUES ('Acme Studio','acme-studio',$1) RETURNING id`, [u.alice])).id;
    for (const [k, role] of [['alice', 'owner'], ['erin', 'admin'], ['bob', 'member'], ['carol', 'member'], ['dave', 'member']] as const) {
      await query(db, `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [acme, u[k], role]);
    }
    const product = (await one(db, `INSERT INTO workspaces (tenant_id, name, slug, description, created_by) VALUES ($1,'Product','product','Customer-facing apps',$2) RETURNING id`, [acme, u.alice])).id;
    await query(db, `INSERT INTO workspaces (tenant_id, name, slug, description, created_by) VALUES ($1,'Internal tools','internal-tools','Ops and back-office',$2)`, [acme, u.alice]);

    const atlas = (await one(
      db,
      `INSERT INTO projects (tenant_id, workspace_id, name, slug, description, contact, owner_user_id, created_by)
       VALUES ($1,$2,'Atlas Mobile App','atlas','The Atlas iOS/Android app and its companion web dashboard. Start with the onboarding checklist, then keep the pinned links handy.','#atlas-team on Slack',$3,$3) RETURNING id`,
      [acme, product, u.alice],
    )).id;
    for (const [k, role] of [['alice', 'project_admin'], ['bob', 'maintainer'], ['carol', 'member'], ['dave', 'viewer']] as const) {
      await query(db, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4,$5)`, [acme, atlas, u[k], role, u.alice]);
    }
    const cat: Record<string, string> = {};
    for (const [i, name] of ['Getting started', 'Design', 'Development', 'Operations'].entries()) {
      cat[name] = (await one(db, `INSERT INTO knowledge_categories (tenant_id, project_id, name, slug, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [acme, atlas, name, name.toLowerCase().replace(/ /g, '-'), i])).id;
    }

    const tagIds = new Map<string, string>();
    const item = async (o: {
      type: 'external_link' | 'internal_document'; title: string; description: string; url?: string; category: string; tags: string[];
      by: string; owner?: string; pinned?: boolean; status?: 'active' | 'archived'; content?: string; daysAgo: number;
      restrict?: { role: 'maintainer' | 'member' | 'viewer'; view: boolean; edit: boolean; archive: boolean }[];
    }) => {
      const norm = o.url ? o.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase() : null;
      const id = (await one(
        db,
        `INSERT INTO knowledge_items (tenant_id, project_id, category_id, type, title, description, external_url, normalized_url, owner_user_id, created_by, updated_by, is_pinned, status, archived_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12, CASE WHEN $12 = 'archived' THEN now() END, now() - make_interval(days => $13 + 3), now() - make_interval(days => $13)) RETURNING id`,
        [acme, atlas, cat[o.category], o.type, o.title, o.description, o.url ?? null, norm, u[o.owner ?? o.by], u[o.by], o.pinned ?? false, o.status ?? 'active', o.daysAgo],
      )).id;
      if (o.type === 'internal_document') {
        await query(db, `INSERT INTO knowledge_documents (knowledge_item_id, tenant_id, project_id, content_md, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6))`, [id, acme, atlas, o.content ?? '', u[o.by], o.daysAgo]);
        await query(db, `INSERT INTO knowledge_document_revisions (tenant_id, project_id, knowledge_item_id, content_md, created_by, created_at) VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6))`, [acme, atlas, id, o.content ?? '', u[o.by], o.daysAgo]);
      }
      for (const t of o.tags) {
        if (!tagIds.has(t)) tagIds.set(t, (await one(db, `INSERT INTO knowledge_tags (tenant_id, project_id, name, slug) VALUES ($1,$2,$3,$3) RETURNING id`, [acme, atlas, t])).id);
        await query(db, `INSERT INTO knowledge_item_tags (project_id, knowledge_item_id, tag_id) VALUES ($1,$2,$3)`, [atlas, id, tagIds.get(t)]);
      }
      for (const r of o.restrict ?? []) {
        await query(db, `INSERT INTO knowledge_item_access_rules (tenant_id, project_id, knowledge_item_id, role, can_view, can_edit, can_archive, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [acme, atlas, id, r.role, r.view, r.edit, r.archive, u.alice]);
      }
      return id;
    };

    const welcome = await item({
      type: 'internal_document', title: 'Welcome to Atlas', category: 'Getting started', tags: ['onboarding'], by: 'alice', pinned: true, daysAgo: 2,
      description: 'What Atlas is, who is on the team, and how we work.',
      content: `# Welcome to Atlas\n\nAtlas is our mobile app for field teams. This page is the starting point for everyone joining the project.\n\n## How we work\n\n- **Planning** happens every second Monday in the Jira board.\n- **Design reviews** are on Thursdays — bring Figma links.\n- **Releases** ship from \`main\` after QA sign-off.\n\n## Who to ask\n\n| Topic | Person |\n|---|---|\n| Product & priorities | Alice Tan |\n| Codebase & releases | Bob Mercer |\n| Design system | Carol Ng |\n\n> If a link here is broken, tell the owner listed on the item — or fix it yourself if you can edit.\n`,
    });
    const figma = await item({ type: 'external_link', title: 'Atlas — Figma design file', url: 'https://www.figma.com/file/atlas-mobile', category: 'Design', tags: ['design', 'figma'], by: 'carol', pinned: true, daysAgo: 1, description: 'Source of truth for every screen. Use the "Ready for dev" page for specs.' });
    const repo = await item({ type: 'external_link', title: 'GitHub repository', url: 'https://github.com/acme/atlas', category: 'Development', tags: ['code', 'frontend', 'backend'], by: 'bob', pinned: true, daysAgo: 4, description: 'Monorepo for the mobile app, web dashboard and API.' });
    await item({ type: 'external_link', title: 'Jira board', url: 'https://acme.atlassian.net/jira/software/projects/ATL/boards/12', category: 'Getting started', tags: ['planning'], by: 'alice', pinned: true, daysAgo: 6, description: 'Sprint board. Filter by your name to see what is assigned to you.' });
    const setup = await item({
      type: 'internal_document', title: 'Local development setup', category: 'Development', tags: ['code', 'onboarding'], by: 'bob', daysAgo: 3,
      description: 'Get the app running on your machine in about 20 minutes.',
      content: `# Local development setup\n\n1. Install Node 22 and pnpm.\n2. Clone the repository and run \`pnpm install\`.\n3. Copy \`.env.example\` to \`.env\`.\n4. Start everything with \`pnpm dev\`.\n\n\`\`\`bash\npnpm dev --filter mobile\n\`\`\`\n\nAsk in **#atlas-dev** if you get stuck.\n`,
    });
    await item({ type: 'external_link', title: 'API reference', url: 'https://docs.acme.test/atlas/api', category: 'Development', tags: ['backend', 'api'], by: 'bob', daysAgo: 9, description: 'Public API reference for authorized project members.' });
    await item({ type: 'external_link', title: 'Staging dashboard', url: 'https://staging.atlas.acme.test', category: 'Operations', tags: ['qa'], by: 'bob', daysAgo: 12, description: 'Staging build of the web dashboard. Reset nightly.' });
    await item({ type: 'internal_document', title: 'Release checklist', category: 'Operations', tags: ['release'], by: 'bob', daysAgo: 15, description: 'Steps to cut and ship a release.', content: `# Release checklist\n\n- [ ] QA sign-off in Jira\n- [ ] Bump version\n- [ ] Tag \`vX.Y.Z\`\n- [ ] Submit to stores\n- [ ] Post release notes\n` });
    await item({ type: 'external_link', title: 'Brand guidelines', url: 'https://brand.acme.test', category: 'Design', tags: ['design'], by: 'carol', daysAgo: 20, description: 'Logo, colour and voice rules for every Acme product.' });
    await item({
      type: 'internal_document', title: 'Production incident runbook', category: 'Operations', tags: ['ops'], by: 'alice', daysAgo: 5,
      description: 'Escalation contacts and production access steps. Restricted to admins and maintainers.',
      content: '# Production incident runbook\n\nRestricted. Escalation tree and access procedures live here.\n',
      restrict: [{ role: 'member', view: false, edit: false, archive: false }, { role: 'viewer', view: false, edit: false, archive: false }],
    });
    await item({ type: 'external_link', title: 'Old prototype (InVision)', url: 'https://invision.acme.test/atlas-v0', category: 'Design', tags: ['design'], by: 'carol', status: 'archived', daysAgo: 60, description: 'Superseded by the Figma file.' });

    const general = (await one(db, `INSERT INTO onboarding_templates (tenant_id, project_id, name, description, created_by, updated_by) VALUES ($1,$2,'Getting started','Everyone on Atlas does these first.',$3,$3) RETURNING id`, [acme, atlas, u.alice])).id;
    const steps: [string, string, string | null, boolean][] = [
      ['Read the welcome page', 'Ten minutes — covers how the team works.', welcome, true],
      ['Open the Figma file', 'Browse the "Ready for dev" page so you know where specs live.', figma, true],
      ['Join #atlas-team on Slack', 'Ask Alice for an invite if you cannot find it.', null, true],
      ['Skim the repository README', 'Optional unless you will write code.', repo, false],
    ];
    for (const [i, [title, instructions, itemId, req]] of steps.entries()) {
      await query(db, `INSERT INTO onboarding_steps (tenant_id, project_id, template_id, knowledge_item_id, title, instructions, sort_order, is_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [acme, atlas, general, itemId, title, instructions, i, req]);
    }
    const dev = (await one(db, `INSERT INTO onboarding_templates (tenant_id, project_id, name, description, target_role, created_by, updated_by) VALUES ($1,$2,'Maintainer setup','For people who maintain code and content.','maintainer',$3,$3) RETURNING id`, [acme, atlas, u.alice])).id;
    await query(db, `INSERT INTO onboarding_steps (tenant_id, project_id, template_id, knowledge_item_id, title, instructions, sort_order) VALUES ($1,$2,$3,$4,'Set up your local environment','Follow the setup guide end to end.',0)`, [acme, atlas, dev, setup]);

    // A second Acme project Carol is not part of — exercises project-level isolation.
    const billing = (await one(db, `INSERT INTO projects (tenant_id, workspace_id, name, slug, description, owner_user_id, created_by) VALUES ($1,$2,'Billing Revamp','billing','Payments and invoicing rebuild.',$3,$3) RETURNING id`, [acme, product, u.alice])).id;
    await query(db, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'project_admin'), ($1,$2,$4,'member')`, [acme, billing, u.alice, u.bob]);
    await query(db, `INSERT INTO knowledge_items (tenant_id, project_id, type, title, description, external_url, normalized_url, created_by, updated_by) VALUES ($1,$2,'external_link','Stripe dashboard','Test-mode account','https://dashboard.stripe.com/test','dashboard.stripe.com/test',$3,$3)`, [acme, billing, u.alice]);

    // ── Globex (separate tenant) ──
    const globex = (await one(db, `INSERT INTO tenants (name, slug, created_by) VALUES ('Globex','globex',$1) RETURNING id`, [u.frank])).id;
    await query(db, `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [globex, u.frank]);
    const gws = (await one(db, `INSERT INTO workspaces (tenant_id, name, slug, created_by) VALUES ($1,'Engineering','engineering',$2) RETURNING id`, [globex, u.frank])).id;
    const gp = (await one(db, `INSERT INTO projects (tenant_id, workspace_id, name, slug, description, owner_user_id, created_by) VALUES ($1,$2,'Globex Secret Project','secret','Should never be visible to Acme users.',$3,$3) RETURNING id`, [globex, gws, u.frank])).id;
    await query(db, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'project_admin')`, [globex, gp, u.frank]);
    await query(db, `INSERT INTO knowledge_items (tenant_id, project_id, type, title, description, created_by, updated_by) VALUES ($1,$2,'internal_document','Globex roadmap','Confidential',$3,$3)`, [globex, gp, u.frank]);
  });
  console.log(`seeded. Sign in as alice@acme.test (owner/admin), bob@ (maintainer), carol@ (member), dave@ (viewer), erin@ (tenant admin, no project access), frank@globex.test — password: ${SEED_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
