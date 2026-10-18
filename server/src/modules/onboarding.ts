import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { parse, projectRole, uuid } from '../lib/validate.js';
import { audit } from '../audit.js';
import { requireProject, requireUser, type ProjectAccess } from '../authz/context.js';
import { projectCan } from '../authz/policy.js';
import { visibleTo } from './knowledge-access.js';

/** Knowledge item references must point at items the *editor* can see in this project. */
async function assertLinkableItem(db: Db, access: ProjectAccess, itemId: string | null | undefined) {
  if (!itemId) return;
  const ok = await one(
    db,
    `SELECT 1 FROM knowledge_items ki WHERE ki.id = $1 AND ki.project_id = $2 AND ki.status = 'active' AND ${visibleTo('ki', '$3::text')}`,
    [itemId, access.projectId, access.role],
  );
  if (!ok) throw invalid('knowledgeItemId: choose an active item from this project');
}

async function loadStep(db: Db, userId: string, stepId: string) {
  const step = await one(db, `SELECT s.*, t.target_role, t.status AS template_status FROM onboarding_steps s JOIN onboarding_templates t ON t.id = s.template_id WHERE s.id = $1`, [stepId]);
  if (!step) throw notFound('step');
  const access = await requireProject(db, userId, step.project_id, 'knowledge.view').catch(() => {
    throw notFound('step');
  });
  return { step, access };
}

export async function onboardingRoutes(app: FastifyInstance) {
  // The caller's own checklist: templates for their role (or all roles), with
  // linked resources only when the caller may see them (FR-010, AC-016).
  app.get('/projects/:projectId/onboarding', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const access = await requireProject(pool, u.id, projectId, 'onboarding.complete');
    const templates = await query(
      pool,
      `SELECT id, name, description, target_role FROM onboarding_templates
        WHERE project_id = $1 AND status = 'active' AND (target_role IS NULL OR target_role = $2)
        ORDER BY target_role NULLS FIRST, created_at`,
      [projectId, access.role],
    );
    const steps = await query(
      pool,
      `SELECT s.id, s.template_id, s.title, s.instructions, s.sort_order, s.is_required, op.status AS progress, op.completed_at,
              CASE WHEN ki.id IS NOT NULL AND ki.status = 'active' AND ${visibleTo('ki', '$2::text')} THEN ki.id END AS item_id,
              CASE WHEN ki.id IS NOT NULL AND ki.status = 'active' AND ${visibleTo('ki', '$2::text')} THEN ki.title END AS item_title,
              CASE WHEN ki.id IS NOT NULL AND ki.status = 'active' AND ${visibleTo('ki', '$2::text')} THEN ki.type END AS item_type
         FROM onboarding_steps s
         JOIN onboarding_templates t ON t.id = s.template_id
         LEFT JOIN knowledge_items ki ON ki.id = s.knowledge_item_id
         LEFT JOIN onboarding_progress op ON op.step_id = s.id AND op.user_id = $3
        WHERE t.project_id = $1 AND t.status = 'active' AND (t.target_role IS NULL OR t.target_role = $2)
        ORDER BY s.sort_order, s.created_at`,
      [projectId, access.role, u.id],
    );
    return {
      canManage: projectCan(access.role, 'onboarding.manage', access.permissions) && access.writable,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        targetRole: t.target_role,
        steps: steps
          .filter((s) => s.template_id === t.id)
          .map((s) => ({
            id: s.id, title: s.title, instructions: s.instructions, sortOrder: s.sort_order, isRequired: s.is_required,
            completed: s.progress === 'completed', completedAt: s.completed_at,
            resource: s.item_id ? { id: s.item_id, title: s.item_title, type: s.item_type } : null,
          })),
      })),
    };
  });

  // All templates (every role) for people who maintain onboarding content.
  app.get('/projects/:projectId/onboarding/templates', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const access = await requireProject(pool, u.id, projectId, 'onboarding.manage');
    const templates = await query(pool, `SELECT id, name, description, target_role, status FROM onboarding_templates WHERE project_id = $1 ORDER BY status, target_role NULLS FIRST, created_at`, [projectId]);
    const steps = await query(
      pool,
      `SELECT s.*, CASE WHEN ki.id IS NOT NULL AND ${visibleTo('ki', '$2::text')} THEN ki.title END AS item_title,
              CASE WHEN ki.id IS NOT NULL AND ${visibleTo('ki', '$2::text')} THEN ki.id END AS item_id
         FROM onboarding_steps s LEFT JOIN knowledge_items ki ON ki.id = s.knowledge_item_id
        WHERE s.project_id = $1 ORDER BY s.sort_order, s.created_at`,
      [projectId, access.role],
    );
    return {
      data: templates.map((t) => ({
        id: t.id, name: t.name, description: t.description, targetRole: t.target_role, status: t.status,
        steps: steps.filter((s) => s.template_id === t.id).map((s) => ({
          id: s.id, title: s.title, instructions: s.instructions, sortOrder: s.sort_order, isRequired: s.is_required,
          resource: s.item_id ? { id: s.item_id, title: s.item_title } : s.knowledge_item_id ? { id: null, title: null, hidden: true } : null,
        })),
      })),
    };
  });

  app.post('/projects/:projectId/onboarding/templates', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(''), targetRole: projectRole.nullable().default(null) }), req.body);
    const t = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'onboarding.manage', { write: true });
      const row = await one(
        db,
        `INSERT INTO onboarding_templates (tenant_id, project_id, name, description, target_role, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [access.tenantId, projectId, body.name, body.description, body.targetRole, u.id],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'onboarding.template_created', targetType: 'onboarding_template', targetId: row.id, metadata: { name: body.name, targetRole: body.targetRole } });
      return row;
    });
    return reply.status(201).send({ id: t.id });
  });

  app.patch('/onboarding/templates/:templateId', async (req) => {
    const u = requireUser(req);
    const { templateId } = parse(z.object({ templateId: uuid }), req.params);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(1000).optional(),
      targetRole: projectRole.nullable().optional(), status: z.enum(['active', 'archived']).optional(),
    }), req.body);
    await tx(async (db) => {
      const t = await one(db, 'SELECT project_id FROM onboarding_templates WHERE id = $1', [templateId]);
      if (!t) throw notFound('template');
      const access = await requireProject(db, u.id, t.project_id, 'onboarding.manage', { write: true }).catch((e) => {
        throw e.status === 404 ? notFound('template') : e;
      });
      await query(
        db,
        `UPDATE onboarding_templates SET name = coalesce($2, name), description = coalesce($3, description),
                target_role = CASE WHEN $4 THEN $5 ELSE target_role END, status = coalesce($6, status), updated_by = $7, updated_at = now() WHERE id = $1`,
        [templateId, body.name ?? null, body.description ?? null, body.targetRole !== undefined, body.targetRole ?? null, body.status ?? null, u.id],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'onboarding.template_updated', targetType: 'onboarding_template', targetId: templateId, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.post('/onboarding/templates/:templateId/steps', async (req, reply) => {
    const u = requireUser(req);
    const { templateId } = parse(z.object({ templateId: uuid }), req.params);
    const body = parse(z.object({
      title: z.string().trim().min(1).max(200), instructions: z.string().trim().max(4000).default(''),
      knowledgeItemId: uuid.nullable().default(null), isRequired: z.boolean().default(true),
    }), req.body);
    const step = await tx(async (db) => {
      const t = await one(db, 'SELECT project_id FROM onboarding_templates WHERE id = $1', [templateId]);
      if (!t) throw notFound('template');
      const access = await requireProject(db, u.id, t.project_id, 'onboarding.manage', { write: true }).catch((e) => {
        throw e.status === 404 ? notFound('template') : e;
      });
      await assertLinkableItem(db, access, body.knowledgeItemId);
      const s = await one(
        db,
        `INSERT INTO onboarding_steps (tenant_id, project_id, template_id, knowledge_item_id, title, instructions, is_required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT coalesce(max(sort_order),0)+1 FROM onboarding_steps WHERE template_id = $3)) RETURNING id`,
        [access.tenantId, access.projectId, templateId, body.knowledgeItemId, body.title, body.instructions, body.isRequired],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'onboarding.step_created', targetType: 'onboarding_step', targetId: s.id });
      return s;
    });
    return reply.status(201).send({ id: step.id });
  });

  app.patch('/onboarding/steps/:stepId', async (req) => {
    const u = requireUser(req);
    const { stepId } = parse(z.object({ stepId: uuid }), req.params);
    const body = parse(z.object({
      title: z.string().trim().min(1).max(200).optional(), instructions: z.string().trim().max(4000).optional(),
      knowledgeItemId: uuid.nullable().optional(), isRequired: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10000).optional(),
    }), req.body);
    await tx(async (db) => {
      const { access } = await loadStep(db, u.id, stepId);
      if (!projectCan(access.role, 'onboarding.manage', access.permissions)) throw forbidden();
      if (!access.writable) throw forbidden('This project is archived.');
      await assertLinkableItem(db, access, body.knowledgeItemId);
      await query(
        db,
        `UPDATE onboarding_steps SET title = coalesce($2, title), instructions = coalesce($3, instructions),
                knowledge_item_id = CASE WHEN $4 THEN $5::uuid ELSE knowledge_item_id END,
                is_required = coalesce($6, is_required), sort_order = coalesce($7, sort_order), updated_at = now() WHERE id = $1`,
        [stepId, body.title ?? null, body.instructions ?? null, body.knowledgeItemId !== undefined, body.knowledgeItemId ?? null, body.isRequired ?? null, body.sortOrder ?? null],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'onboarding.step_updated', targetType: 'onboarding_step', targetId: stepId, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.delete('/onboarding/steps/:stepId', async (req) => {
    const u = requireUser(req);
    const { stepId } = parse(z.object({ stepId: uuid }), req.params);
    await tx(async (db) => {
      const { access } = await loadStep(db, u.id, stepId);
      if (!projectCan(access.role, 'onboarding.manage', access.permissions)) throw forbidden();
      if (!access.writable) throw forbidden('This project is archived.');
      await query(db, 'DELETE FROM onboarding_steps WHERE id = $1', [stepId]);
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'onboarding.step_deleted', targetType: 'onboarding_step', targetId: stepId });
    });
    return { ok: true };
  });

  app.post('/onboarding/steps/:stepId/complete', async (req) => {
    const u = requireUser(req);
    const { stepId } = parse(z.object({ stepId: uuid }), req.params);
    const body = parse(z.object({ completed: z.boolean().default(true) }), req.body);
    await tx(async (db) => {
      const { step, access } = await loadStep(db, u.id, stepId);
      // Only steps on a checklist that applies to the caller's role.
      if (step.template_status !== 'active' || (step.target_role && step.target_role !== access.role)) throw notFound('step');
      await query(
        db,
        `INSERT INTO onboarding_progress (tenant_id, project_id, template_id, step_id, user_id, status, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'completed' THEN now() END)
         ON CONFLICT (step_id, user_id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at, updated_at = now()`,
        [access.tenantId, access.projectId, step.template_id, stepId, u.id, body.completed ? 'completed' : 'not_started'],
      );
    });
    return { ok: true, completed: body.completed };
  });

  // P1 completion reporting for Project Admins.
  app.get('/projects/:projectId/onboarding/report', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await requireProject(pool, u.id, projectId, 'members.manage');
    const rows = await query(
      pool,
      `SELECT u.id, u.display_name, pm.role, pm.joined_at,
              count(s.id) FILTER (WHERE s.is_required)::int AS required,
              count(s.id) FILTER (WHERE s.is_required AND op.status = 'completed')::int AS completed
         FROM project_memberships pm JOIN users u ON u.id = pm.user_id
         LEFT JOIN onboarding_templates t ON t.project_id = pm.project_id AND t.status = 'active' AND (t.target_role IS NULL OR t.target_role = pm.role)
         LEFT JOIN onboarding_steps s ON s.template_id = t.id
         LEFT JOIN onboarding_progress op ON op.step_id = s.id AND op.user_id = pm.user_id
        WHERE pm.project_id = $1 AND pm.status = 'active'
        GROUP BY u.id, u.display_name, pm.role, pm.joined_at ORDER BY pm.joined_at DESC`,
      [projectId],
    );
    return { data: rows.map((r) => ({ userId: r.id, displayName: r.display_name, role: r.role, joinedAt: r.joined_at, required: r.required, completed: r.completed })) };
  });
}
