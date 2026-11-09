-- ==============================================================================
-- ONE TEAM — MIGRATION 005: SYNC ENGINE SUPPORT & DETERMINISTIC RECONCILIATION
-- 1. Monotonic versioning (BIGINT DEFAULT 1) on 9 business tables
-- 2. Create sync_mutations table for mutation idempotency and response caching
-- 3. Create sync_tombstones table with cursor_seq BIGSERIAL for delta sync
-- 4. Triggers to advance versions and record tombstones on DELETE/UPDATE
-- 5. Atomic RPC: public.apply_sync_mutation(...)
-- 6. Atomic RPC: public.fetch_workspace_sync_delta(...)
-- 7. RLS policies and indexes for multi-tenant workspace isolation
-- ==============================================================================

-- 1. ADD VERSION COLUMN TO 9 CORE BUSINESS TABLES
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'tasks',
    'projects',
    'clients',
    'transactions',
    'strategic_goals',
    'strategic_priorities',
    'strategic_plans',
    'strategy_missions',
    'strategy_visions',
    'workspace_settings'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = tbl
        AND column_name = 'version'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN version BIGINT NOT NULL DEFAULT 1;', tbl);
    END IF;
  END LOOP;
END;
$$;

-- 2. CREATE SYNC_MUTATIONS TABLE (Server-side Idempotency & Audit)
CREATE TABLE IF NOT EXISTS public.sync_mutations (
  mutation_id UUID PRIMARY KEY,
  client_mutation_id TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
  base_version BIGINT,
  resulting_version BIGINT,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'CONFLICT', 'REJECTED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_mutations_client_id
  ON public.sync_mutations(workspace_id, client_mutation_id);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_workspace_entity
  ON public.sync_mutations(workspace_id, entity_type, entity_id);

-- Enable RLS
ALTER TABLE public.sync_mutations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace sync mutations"
  ON public.sync_mutations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = sync_mutations.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

-- 3. CREATE SYNC_TOMBSTONES TABLE (Monotonic Cursor for Deletions)
CREATE TABLE IF NOT EXISTS public.sync_tombstones (
  cursor_seq BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_version BIGINT NOT NULL,
  deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_cursor
  ON public.sync_tombstones(workspace_id, cursor_seq);
CREATE INDEX IF NOT EXISTS idx_sync_tombstones_entity
  ON public.sync_tombstones(workspace_id, entity_type, entity_id);

-- Enable RLS
ALTER TABLE public.sync_tombstones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read workspace tombstones"
  ON public.sync_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = sync_tombstones.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

-- 4. TOMBSTONE LOGGING AND VERSION INCREMENT TRIGGERS
CREATE OR REPLACE FUNCTION public.fn_sync_record_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_entity_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'workspace_settings' THEN
    v_entity_id := OLD.workspace_id::text;
  ELSE
    v_entity_id := OLD.id::text;
  END IF;

  INSERT INTO public.sync_tombstones (
    workspace_id,
    entity_type,
    entity_id,
    deleted_version,
    deleted_by,
    deleted_at
  ) VALUES (
    OLD.workspace_id,
    TG_TABLE_NAME,
    v_entity_id,
    COALESCE(OLD.version, 1),
    auth.uid(),
    timezone('utc'::text, now())
  );
  RETURN OLD;
END;
$$;

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'tasks',
    'projects',
    'clients',
    'transactions',
    'strategic_goals',
    'strategic_priorities',
    'strategic_plans',
    'strategy_missions',
    'strategy_visions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_tombstone ON public.%I;', tbl, tbl);
    EXECUTE format('
      CREATE TRIGGER trg_%I_tombstone
      AFTER DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.fn_sync_record_tombstone();
    ', tbl, tbl);
  END LOOP;
END;
$$;

-- 5. ATOMIC RPC: public.apply_sync_mutation
CREATE OR REPLACE FUNCTION public.apply_sync_mutation(
  p_client_mutation_id TEXT,
  p_workspace_id UUID,
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_action TEXT,
  p_base_version BIGINT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_role TEXT;
  v_existing_mutation RECORD;
  v_current_record RECORD;
  v_current_version BIGINT;
  v_new_version BIGINT := 1;
  v_result JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED');
  END IF;

  -- Verify membership & role
  SELECT role INTO v_role
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id
    AND user_id = v_caller_id;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_A_MEMBER');
  END IF;

  IF v_role = 'viewer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED_VIEWER');
  END IF;

  -- 1. Idempotency Check: Already processed?
  SELECT * INTO v_existing_mutation
  FROM public.sync_mutations
  WHERE workspace_id = p_workspace_id
    AND client_mutation_id = p_client_mutation_id
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', (v_existing_mutation.status = 'APPLIED'),
      'status', 'ALREADY_APPLIED',
      'mutation_status', v_existing_mutation.status,
      'entity_id', v_existing_mutation.entity_id,
      'resulting_version', v_existing_mutation.resulting_version,
      'response', v_existing_mutation.response
    );
  END IF;

  -- 2. Read existing entity version if exists
  IF p_entity_type = 'tasks' THEN
    SELECT version INTO v_current_version FROM public.tasks WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'projects' THEN
    SELECT version INTO v_current_version FROM public.projects WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'clients' THEN
    SELECT version INTO v_current_version FROM public.clients WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'transactions' THEN
    SELECT version INTO v_current_version FROM public.transactions WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'strategic_goals' THEN
    SELECT version INTO v_current_version FROM public.strategic_goals WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'strategic_priorities' THEN
    SELECT version INTO v_current_version FROM public.strategic_priorities WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'strategic_plans' THEN
    SELECT version INTO v_current_version FROM public.strategic_plans WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'strategy_missions' THEN
    SELECT version INTO v_current_version FROM public.strategy_missions WHERE workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'strategy_visions' THEN
    SELECT version INTO v_current_version FROM public.strategy_visions WHERE workspace_id = p_workspace_id FOR UPDATE;
  ELSIF p_entity_type = 'workspace_settings' THEN
    SELECT version INTO v_current_version FROM public.workspace_settings WHERE workspace_id = p_workspace_id FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ENTITY_TYPE');
  END IF;

  -- 3. Concurrency check
  IF p_action = 'CREATE' THEN
    IF v_current_version IS NOT NULL THEN
      -- Already exists!
      v_new_version := v_current_version + 1;
    ELSE
      v_new_version := 1;
    END IF;
  ELSIF p_action IN ('UPDATE', 'DELETE') THEN
    IF v_current_version IS NULL THEN
      -- Record not found or already deleted
      INSERT INTO public.sync_mutations (
        mutation_id, client_mutation_id, workspace_id, user_id,
        entity_type, entity_id, action, base_version, resulting_version,
        status, payload, response
      ) VALUES (
        gen_random_uuid(), p_client_mutation_id, p_workspace_id, v_caller_id,
        p_entity_type, p_entity_id, p_action, p_base_version, NULL,
        'CONFLICT', p_payload, jsonb_build_object('error', 'ENTITY_NOT_FOUND')
      );
      RETURN jsonb_build_object(
        'success', false,
        'status', 'VERSION_CONFLICT',
        'error', 'ENTITY_NOT_FOUND',
        'current_version', NULL
      );
    END IF;

    IF p_base_version IS NOT NULL AND p_base_version < v_current_version THEN
      -- Concurrency conflict
      INSERT INTO public.sync_mutations (
        mutation_id, client_mutation_id, workspace_id, user_id,
        entity_type, entity_id, action, base_version, resulting_version,
        status, payload, response
      ) VALUES (
        gen_random_uuid(), p_client_mutation_id, p_workspace_id, v_caller_id,
        p_entity_type, p_entity_id, p_action, p_base_version, v_current_version,
        'CONFLICT', p_payload, jsonb_build_object('error', 'VERSION_CONFLICT', 'current_version', v_current_version)
      );
      RETURN jsonb_build_object(
        'success', false,
        'status', 'VERSION_CONFLICT',
        'current_version', v_current_version,
        'base_version', p_base_version
      );
    END IF;

    v_new_version := v_current_version + 1;
  END IF;

  -- 4. Apply Mutation
  IF p_action = 'DELETE' THEN
    IF p_entity_type = 'tasks' THEN
      DELETE FROM public.tasks WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'projects' THEN
      DELETE FROM public.projects WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'clients' THEN
      DELETE FROM public.clients WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'transactions' THEN
      DELETE FROM public.transactions WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'strategic_goals' THEN
      DELETE FROM public.strategic_goals WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'strategic_priorities' THEN
      DELETE FROM public.strategic_priorities WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    ELSIF p_entity_type = 'strategic_plans' THEN
      DELETE FROM public.strategic_plans WHERE id = p_entity_id::uuid AND workspace_id = p_workspace_id;
    END IF;
    v_result := jsonb_build_object('deleted', true, 'id', p_entity_id);
  ELSE
    -- CREATE or UPDATE
    IF p_entity_type = 'tasks' THEN
      INSERT INTO public.tasks (
        id, workspace_id, project_id, title, description, status, priority,
        due_date, completed, comments, activities, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        NULLIF(p_payload->>'project_id', '')::uuid,
        COALESCE(p_payload->>'title', 'Без названия'),
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'status', 'todo'),
        COALESCE(p_payload->>'priority', 'medium'),
        (p_payload->>'due_date')::date,
        COALESCE((p_payload->>'completed')::boolean, false),
        COALESCE(p_payload->'comments', '[]'::jsonb),
        COALESCE(p_payload->'activities', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        project_id = NULLIF(EXCLUDED.project_id::text, '')::uuid,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        due_date = EXCLUDED.due_date,
        completed = EXCLUDED.completed,
        comments = EXCLUDED.comments,
        activities = EXCLUDED.activities,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(tasks.*) INTO v_result;

    ELSIF p_entity_type = 'projects' THEN
      INSERT INTO public.projects (
        id, workspace_id, name, description, status, progress, deadline,
        category, is_archived, client_id, client_name, member_ids, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'name', 'Новый проект'),
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'status', 'planning'),
        COALESCE((p_payload->>'progress')::int, 0),
        (p_payload->>'deadline')::date,
        COALESCE(p_payload->>'category', 'Общий'),
        COALESCE((p_payload->>'is_archived')::boolean, false),
        NULLIF(p_payload->>'client_id', '')::uuid,
        p_payload->>'client_name',
        COALESCE(p_payload->'member_ids', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        progress = EXCLUDED.progress,
        deadline = EXCLUDED.deadline,
        category = EXCLUDED.category,
        is_archived = EXCLUDED.is_archived,
        client_id = EXCLUDED.client_id,
        client_name = EXCLUDED.client_name,
        member_ids = EXCLUDED.member_ids,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(projects.*) INTO v_result;

    ELSIF p_entity_type = 'clients' THEN
      INSERT INTO public.clients (
        id, workspace_id, name, contact_person, email, phone, status,
        deal_value, deal_currency, associated_project_id, description,
        avatar, last_interaction, notes, interactions, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'name', 'Новый клиент'),
        COALESCE(p_payload->>'contact_person', ''),
        COALESCE(p_payload->>'email', ''),
        COALESCE(p_payload->>'phone', ''),
        COALESCE(p_payload->>'status', 'lead'),
        COALESCE((p_payload->>'deal_value')::numeric, 0),
        COALESCE(p_payload->>'deal_currency', 'KZT'),
        NULLIF(p_payload->>'associated_project_id', '')::uuid,
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'avatar', ''),
        (p_payload->>'last_interaction')::date,
        COALESCE(p_payload->'notes', '[]'::jsonb),
        COALESCE(p_payload->'interactions', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        contact_person = EXCLUDED.contact_person,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        status = EXCLUDED.status,
        deal_value = EXCLUDED.deal_value,
        deal_currency = EXCLUDED.deal_currency,
        associated_project_id = EXCLUDED.associated_project_id,
        description = EXCLUDED.description,
        avatar = EXCLUDED.avatar,
        last_interaction = EXCLUDED.last_interaction,
        notes = EXCLUDED.notes,
        interactions = EXCLUDED.interactions,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(clients.*) INTO v_result;

    ELSIF p_entity_type = 'transactions' THEN
      INSERT INTO public.transactions (
        id, workspace_id, title, amount, currency, type, category,
        date, status, project_id, client_id, notes, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'title', 'Транзакция'),
        COALESCE((p_payload->>'amount')::numeric, 0),
        COALESCE(p_payload->>'currency', 'KZT'),
        COALESCE(p_payload->>'type', 'expense'),
        COALESCE(p_payload->>'category', 'operations'),
        (p_payload->>'date')::date,
        COALESCE(p_payload->>'status', 'completed'),
        NULLIF(p_payload->>'project_id', '')::uuid,
        NULLIF(p_payload->>'client_id', '')::uuid,
        COALESCE(p_payload->>'notes', ''),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        type = EXCLUDED.type,
        category = EXCLUDED.category,
        date = EXCLUDED.date,
        status = EXCLUDED.status,
        project_id = EXCLUDED.project_id,
        client_id = EXCLUDED.client_id,
        notes = EXCLUDED.notes,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(transactions.*) INTO v_result;

    ELSIF p_entity_type = 'strategic_goals' THEN
      INSERT INTO public.strategic_goals (
        id, workspace_id, title, description, category, owner_id, owner_name,
        start_date, target_date, progress, status, related_project_ids,
        success_criteria, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'title', 'Цель'),
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'category', 'Развитие'),
        NULLIF(p_payload->>'owner_id', '')::uuid,
        COALESCE(p_payload->>'owner_name', ''),
        (p_payload->>'start_date')::date,
        (p_payload->>'target_date')::date,
        COALESCE((p_payload->>'progress')::int, 0),
        COALESCE(p_payload->>'status', 'active'),
        COALESCE(p_payload->'related_project_ids', '[]'::jsonb),
        COALESCE(p_payload->'success_criteria', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        owner_name = EXCLUDED.owner_name,
        start_date = EXCLUDED.start_date,
        target_date = EXCLUDED.target_date,
        progress = EXCLUDED.progress,
        status = EXCLUDED.status,
        related_project_ids = EXCLUDED.related_project_ids,
        success_criteria = EXCLUDED.success_criteria,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(strategic_goals.*) INTO v_result;

    ELSIF p_entity_type = 'strategic_priorities' THEN
      INSERT INTO public.strategic_priorities (
        id, workspace_id, name, description, importance, owner_name,
        expected_result, deadline, status, related_goal_id, sort_order,
        progress, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'name', 'Приоритет'),
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'importance', 'high'),
        COALESCE(p_payload->>'owner_name', ''),
        COALESCE(p_payload->>'expected_result', ''),
        (p_payload->>'deadline')::date,
        COALESCE(p_payload->>'status', 'active'),
        NULLIF(p_payload->>'related_goal_id', '')::uuid,
        COALESCE((p_payload->>'order')::int, (p_payload->>'sort_order')::int, 0),
        COALESCE((p_payload->>'progress')::int, 0),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        importance = EXCLUDED.importance,
        owner_name = EXCLUDED.owner_name,
        expected_result = EXCLUDED.expected_result,
        deadline = EXCLUDED.deadline,
        status = EXCLUDED.status,
        related_goal_id = EXCLUDED.related_goal_id,
        sort_order = EXCLUDED.sort_order,
        progress = EXCLUDED.progress,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(strategic_priorities.*) INTO v_result;

    ELSIF p_entity_type = 'strategic_plans' THEN
      INSERT INTO public.strategic_plans (
        id, workspace_id, title, description, time_period, quarter, month,
        owner_name, status, progress, related_goal_id, expected_outcome,
        deadline, sort_order, version, updated_at
      ) VALUES (
        p_entity_id::uuid, p_workspace_id,
        COALESCE(p_payload->>'title', 'План'),
        COALESCE(p_payload->>'description', ''),
        COALESCE(p_payload->>'time_period', 'Q1'),
        COALESCE(p_payload->>'quarter', 'Q1'),
        COALESCE(p_payload->>'month', ''),
        COALESCE(p_payload->>'owner_name', ''),
        COALESCE(p_payload->>'status', 'planned'),
        COALESCE((p_payload->>'progress')::int, 0),
        NULLIF(p_payload->>'related_goal_id', '')::uuid,
        COALESCE(p_payload->>'expected_outcome', ''),
        (p_payload->>'deadline')::date,
        COALESCE((p_payload->>'order')::int, (p_payload->>'sort_order')::int, 0),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        time_period = EXCLUDED.time_period,
        quarter = EXCLUDED.quarter,
        month = EXCLUDED.month,
        owner_name = EXCLUDED.owner_name,
        status = EXCLUDED.status,
        progress = EXCLUDED.progress,
        related_goal_id = EXCLUDED.related_goal_id,
        expected_outcome = EXCLUDED.expected_outcome,
        deadline = EXCLUDED.deadline,
        sort_order = EXCLUDED.sort_order,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(strategic_plans.*) INTO v_result;

    ELSIF p_entity_type = 'strategy_missions' THEN
      INSERT INTO public.strategy_missions (
        workspace_id, statement, purpose, customer_value, principles,
        owner_name, revisions, version, updated_at
      ) VALUES (
        p_workspace_id,
        COALESCE(p_payload->>'statement', ''),
        COALESCE(p_payload->>'purpose', ''),
        COALESCE(p_payload->>'customer_value', ''),
        COALESCE(p_payload->'principles', '[]'::jsonb),
        COALESCE(p_payload->>'owner_name', ''),
        COALESCE(p_payload->'revisions', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        statement = EXCLUDED.statement,
        purpose = EXCLUDED.purpose,
        customer_value = EXCLUDED.customer_value,
        principles = EXCLUDED.principles,
        owner_name = EXCLUDED.owner_name,
        revisions = EXCLUDED.revisions,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(strategy_missions.*) INTO v_result;

    ELSIF p_entity_type = 'strategy_visions' THEN
      INSERT INTO public.strategy_visions (
        workspace_id, statement, desired_state, direction, target_horizon,
        expected_outcomes, owner_name, revisions, version, updated_at
      ) VALUES (
        p_workspace_id,
        COALESCE(p_payload->>'statement', ''),
        COALESCE(p_payload->>'desired_state', ''),
        COALESCE(p_payload->>'direction', ''),
        COALESCE(p_payload->>'target_horizon', '3_years'),
        COALESCE(p_payload->'expected_outcomes', '[]'::jsonb),
        COALESCE(p_payload->>'owner_name', ''),
        COALESCE(p_payload->'revisions', '[]'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        statement = EXCLUDED.statement,
        desired_state = EXCLUDED.desired_state,
        direction = EXCLUDED.direction,
        target_horizon = EXCLUDED.target_horizon,
        expected_outcomes = EXCLUDED.expected_outcomes,
        owner_name = EXCLUDED.owner_name,
        revisions = EXCLUDED.revisions,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(strategy_visions.*) INTO v_result;

    ELSIF p_entity_type = 'workspace_settings' THEN
      INSERT INTO public.workspace_settings (
        workspace_id, default_currency, theme, notifications_config, version, updated_at
      ) VALUES (
        p_workspace_id,
        COALESCE(p_payload->>'default_currency', p_payload->>'defaultCurrency', 'KZT'),
        COALESCE(p_payload->>'theme', 'dark'),
        COALESCE(p_payload->'notifications_config', p_payload->'notifications', '{"taskNotifications":true,"projectNotifications":true,"teamNotifications":true,"clientNotifications":true,"financeNotifications":true,"strategyNotifications":true,"deadlineReminders":true,"browserNotifications":true}'::jsonb),
        v_new_version,
        timezone('utc'::text, now())
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        default_currency = EXCLUDED.default_currency,
        theme = EXCLUDED.theme,
        notifications_config = EXCLUDED.notifications_config,
        version = v_new_version,
        updated_at = timezone('utc'::text, now())
      RETURNING to_jsonb(workspace_settings.*) INTO v_result;

    END IF;
  END IF;

  -- 5. Record successful mutation in sync_mutations
  INSERT INTO public.sync_mutations (
    mutation_id, client_mutation_id, workspace_id, user_id,
    entity_type, entity_id, action, base_version, resulting_version,
    status, payload, response
  ) VALUES (
    gen_random_uuid(), p_client_mutation_id, p_workspace_id, v_caller_id,
    p_entity_type, p_entity_id, p_action, p_base_version, v_new_version,
    'APPLIED', p_payload, v_result
  );

  RETURN jsonb_build_object(
    'success', true,
    'status', 'APPLIED',
    'entity_id', p_entity_id,
    'version', v_new_version,
    'record', v_result
  );
END;
$$;

-- 6. ATOMIC RPC: public.fetch_workspace_sync_delta
CREATE OR REPLACE FUNCTION public.fetch_workspace_sync_delta(
  p_workspace_id UUID,
  p_since_cursor_seq BIGINT DEFAULT 0,
  p_since_version BIGINT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_role TEXT;
  v_max_cursor BIGINT;
  v_tombstones JSONB;
  v_tasks JSONB;
  v_projects JSONB;
  v_clients JSONB;
  v_transactions JSONB;
  v_goals JSONB;
  v_priorities JSONB;
  v_plans JSONB;
  v_mission JSONB;
  v_vision JSONB;
  v_settings JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED');
  END IF;

  SELECT role INTO v_role
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id
    AND user_id = v_caller_id;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_A_MEMBER');
  END IF;

  SELECT COALESCE(MAX(cursor_seq), 0) INTO v_max_cursor
  FROM public.sync_tombstones
  WHERE workspace_id = p_workspace_id;

  -- Fetch tombstones created after p_since_cursor_seq
  SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO v_tombstones
  FROM (
    SELECT cursor_seq, entity_type, entity_id, deleted_version, deleted_at
    FROM public.sync_tombstones
    WHERE workspace_id = p_workspace_id
      AND cursor_seq > p_since_cursor_seq
    ORDER BY cursor_seq ASC
  ) t;

  -- Fetch entities modified after p_since_version
  SELECT COALESCE(jsonb_agg(to_jsonb(tk.*)), '[]'::jsonb) INTO v_tasks
  FROM public.tasks tk
  WHERE tk.workspace_id = p_workspace_id AND tk.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(pj.*)), '[]'::jsonb) INTO v_projects
  FROM public.projects pj
  WHERE pj.workspace_id = p_workspace_id AND pj.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(cl.*)), '[]'::jsonb) INTO v_clients
  FROM public.clients cl
  WHERE cl.workspace_id = p_workspace_id AND cl.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(tr.*)), '[]'::jsonb) INTO v_transactions
  FROM public.transactions tr
  WHERE tr.workspace_id = p_workspace_id AND tr.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(sg.*)), '[]'::jsonb) INTO v_goals
  FROM public.strategic_goals sg
  WHERE sg.workspace_id = p_workspace_id AND sg.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(sp.*)), '[]'::jsonb) INTO v_priorities
  FROM public.strategic_priorities sp
  WHERE sp.workspace_id = p_workspace_id AND sp.version > p_since_version;

  SELECT COALESCE(jsonb_agg(to_jsonb(pl.*)), '[]'::jsonb) INTO v_plans
  FROM public.strategic_plans pl
  WHERE pl.workspace_id = p_workspace_id AND pl.version > p_since_version;

  SELECT to_jsonb(sm.*) INTO v_mission
  FROM public.strategy_missions sm
  WHERE sm.workspace_id = p_workspace_id AND sm.version > p_since_version;

  SELECT to_jsonb(sv.*) INTO v_vision
  FROM public.strategy_visions sv
  WHERE sv.workspace_id = p_workspace_id AND sv.version > p_since_version;

  SELECT to_jsonb(ws.*) INTO v_settings
  FROM public.workspace_settings ws
  WHERE ws.workspace_id = p_workspace_id AND ws.version > p_since_version;

  RETURN jsonb_build_object(
    'success', true,
    'workspace_id', p_workspace_id,
    'cursor_seq', v_max_cursor,
    'tombstones', v_tombstones,
    'entities', jsonb_build_object(
      'tasks', v_tasks,
      'projects', v_projects,
      'clients', v_clients,
      'transactions', v_transactions,
      'strategic_goals', v_goals,
      'strategic_priorities', v_priorities,
      'strategic_plans', v_plans,
      'strategy_mission', v_mission,
      'strategy_vision', v_vision,
      'workspace_settings', v_settings
    )
  );
END;
$$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
