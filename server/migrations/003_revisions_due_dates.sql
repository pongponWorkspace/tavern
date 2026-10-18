-- Document version history (FR-006 P1) and onboarding due dates (FR-010 P1).

CREATE TABLE knowledge_document_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  project_id        uuid NOT NULL,
  knowledge_item_id uuid NOT NULL,
  content_md        text NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  restored_from     uuid,
  FOREIGN KEY (project_id, knowledge_item_id) REFERENCES knowledge_items (project_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_document_revisions_item_idx ON knowledge_document_revisions (knowledge_item_id, created_at DESC);

-- Existing documents start their history with their current content.
INSERT INTO knowledge_document_revisions (tenant_id, project_id, knowledge_item_id, content_md, created_by, created_at)
SELECT tenant_id, project_id, knowledge_item_id, content_md, updated_by, updated_at FROM knowledge_documents;

-- Days after joining the project by which a step should be done (null = no due date).
ALTER TABLE onboarding_steps ADD COLUMN due_days integer CHECK (due_days BETWEEN 1 AND 365);
