BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE SCHEMA agent_worker;

CREATE FUNCTION agent_worker.valid_limits(limits_input jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  expected_keys text[] := ARRAY[
    'nonterminalPilotRuns', 'modelCallsPerTick', 'modelCallsPerRun',
    'inputTokensPerCall', 'outputTokensPerCall', 'inputTokensPerRun',
    'outputTokensPerRun', 'tickDeadlineSeconds', 'modelCallDeadlineSeconds',
    'leaseSeconds', 'expiredLeaseRecoveries', 'ciWaitSeconds',
    'reviewWaitSeconds', 'runLifetimeSeconds', 'repairCycles'
  ];
  key_name text;
  limit_value numeric;
  minimum_value numeric;
  maximum_value numeric;
  key_count integer := 0;
BEGIN
  IF jsonb_typeof(limits_input) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(limits_input) LOOP
    key_count := key_count + 1;
    IF NOT (key_name = ANY(expected_keys)) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF key_count <> cardinality(expected_keys) THEN
    RETURN false;
  END IF;

  FOREACH key_name IN ARRAY expected_keys LOOP
    IF jsonb_typeof(limits_input -> key_name) IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;

    limit_value := (limits_input ->> key_name)::numeric;
    minimum_value := CASE
      WHEN key_name IN ('expiredLeaseRecoveries', 'repairCycles') THEN 0
      ELSE 1
    END;
    maximum_value := CASE key_name
      WHEN 'nonterminalPilotRuns' THEN 1
      WHEN 'modelCallsPerTick' THEN 1
      WHEN 'modelCallsPerRun' THEN 20
      WHEN 'inputTokensPerCall' THEN 65536
      WHEN 'outputTokensPerCall' THEN 2000
      WHEN 'inputTokensPerRun' THEN 100000
      WHEN 'outputTokensPerRun' THEN 20000
      WHEN 'tickDeadlineSeconds' THEN 90
      WHEN 'modelCallDeadlineSeconds' THEN 45
      WHEN 'leaseSeconds' THEN 180
      WHEN 'expiredLeaseRecoveries' THEN 2
      WHEN 'ciWaitSeconds' THEN 1800
      WHEN 'reviewWaitSeconds' THEN 1800
      WHEN 'runLifetimeSeconds' THEN 7200
      WHEN 'repairCycles' THEN 2
    END;

    IF limit_value <> trunc(limit_value)
        OR limit_value < minimum_value
        OR limit_value > maximum_value THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN (limits_input ->> 'modelCallsPerTick')::numeric
        <= (limits_input ->> 'modelCallsPerRun')::numeric
    AND (limits_input ->> 'inputTokensPerCall')::numeric
        <= (limits_input ->> 'inputTokensPerRun')::numeric
    AND (limits_input ->> 'outputTokensPerCall')::numeric
        <= (limits_input ->> 'outputTokensPerRun')::numeric
    AND (limits_input ->> 'modelCallDeadlineSeconds')::numeric
        <= (limits_input ->> 'tickDeadlineSeconds')::numeric
    AND (limits_input ->> 'tickDeadlineSeconds')::numeric
        < (limits_input ->> 'leaseSeconds')::numeric
    AND (limits_input ->> 'leaseSeconds')::numeric
        <= (limits_input ->> 'runLifetimeSeconds')::numeric
    AND (limits_input ->> 'ciWaitSeconds')::numeric
        <= (limits_input ->> 'runLifetimeSeconds')::numeric
    AND (limits_input ->> 'reviewWaitSeconds')::numeric
        <= (limits_input ->> 'runLifetimeSeconds')::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$;

CREATE TABLE agent_worker.runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES agent_intake.jobs(job_id),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  repository_full_name text NOT NULL CHECK (
    repository_full_name ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'
  ),
  issue_id bigint NOT NULL CHECK (issue_id > 0),
  issue_number bigint NOT NULL CHECK (issue_number > 0),
  actor_id bigint NOT NULL CHECK (actor_id > 0),
  manifest_hash text NOT NULL UNIQUE CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  base_revision text NOT NULL CHECK (base_revision ~ '^[a-f0-9]{40}$'),
  policy_revision text NOT NULL CHECK (policy_revision ~ '^[a-f0-9]{40}$'),
  limits jsonb NOT NULL CHECK (agent_worker.valid_limits(limits)),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN (
    'claimed', 'generating_tests', 'waiting_red_ci', 'implementing',
    'waiting_ci', 'opening_pr', 'waiting_review', 'repairing',
    'ready_for_human', 'needs_attention', 'cancelled'
  )),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_token uuid,
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  recovery_count integer NOT NULL DEFAULT 0 CHECK (
    recovery_count >= 0
    AND recovery_count <= (limits ->> 'expiredLeaseRecoveries')::integer
  ),
  model_call_count integer NOT NULL DEFAULT 0 CHECK (
    model_call_count >= 0
    AND model_call_count <= (limits ->> 'modelCallsPerRun')::integer
  ),
  reserved_input_tokens integer NOT NULL DEFAULT 0 CHECK (
    reserved_input_tokens >= 0
    AND reserved_input_tokens <= (limits ->> 'inputTokensPerRun')::integer
  ),
  reserved_output_tokens integer NOT NULL DEFAULT 0 CHECK (
    reserved_output_tokens >= 0
    AND reserved_output_tokens <= (limits ->> 'outputTokensPerRun')::integer
  ),
  repair_cycle_count integer NOT NULL DEFAULT 0 CHECK (
    repair_cycle_count >= 0
    AND repair_cycle_count <= (limits ->> 'repairCycles')::integer
  ),
  expected_head_sha text CHECK (
    expected_head_sha IS NULL OR expected_head_sha ~ '^[a-f0-9]{40}$'
  ),
  branch_name text CHECK (
    branch_name IS NULL OR branch_name = 'agent-work/' || run_id::text
  ),
  pull_request_number bigint CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  last_check_run_id bigint CHECK (last_check_run_id IS NULL OR last_check_run_id > 0),
  review_head_sha text CHECK (review_head_sha IS NULL OR review_head_sha ~ '^[a-f0-9]{40}$'),
  blocker_code text CHECK (blocker_code IS NULL OR blocker_code IN (
    'lease_recovery_limit', 'model_call_budget_exhausted',
    'model_token_budget_exhausted', 'model_input_token_limit',
    'model_tick_deadline', 'model_run_deadline', 'model_call_deadline',
    'model_usage_unreported', 'model_usage_invalid', 'model_usage_exceeded',
    'model_outcome_uncertain', 'model_spend_limit', 'model_payment_failure', 'model_restricted',
    'model_provider_failure', 'model_contract_unknown', 'repair_cycle_limit'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  CHECK ((lease_token IS NULL) = (lease_started_at IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (terminal_at IS NULL OR lease_token IS NULL),
  CHECK ((state IN ('ready_for_human', 'needs_attention', 'cancelled')) = (terminal_at IS NOT NULL))
);

CREATE UNIQUE INDEX one_nonterminal_pilot
  ON agent_worker.runs ((true))
  WHERE terminal_at IS NULL;

CREATE TABLE agent_worker.operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_worker.runs(run_id),
  operation_key text NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN (
    'model_call', 'branch_create', 'commit_create', 'pr_create'
  )),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  expected_head_sha text CHECK (
    expected_head_sha IS NULL OR expected_head_sha ~ '^[a-f0-9]{40}$'
  ),
  owner_generation bigint CHECK (owner_generation IS NULL OR owner_generation > 0),
  reserved_input_tokens integer CHECK (
    reserved_input_tokens IS NULL OR reserved_input_tokens BETWEEN 1 AND 65536
  ),
  reserved_output_tokens integer CHECK (
    reserved_output_tokens IS NULL OR reserved_output_tokens BETWEEN 1 AND 2000
  ),
  requested_output_tokens integer CHECK (
    requested_output_tokens IS NULL OR requested_output_tokens BETWEEN 1 AND 2000
  ),
  call_deadline_at timestamptz,
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code IN (
    'success', 'usage_unreported', 'invalid_usage', 'excess_usage',
    'uncertain', 'spend_limit', 'payment_failure', 'restricted_model', 'provider_failure',
    'deadline', 'unknown_contract'
  )),
  outcome_blocker_code text CHECK (outcome_blocker_code IS NULL OR outcome_blocker_code IN (
    'model_call_budget_exhausted', 'model_token_budget_exhausted',
    'model_input_token_limit', 'model_tick_deadline', 'model_run_deadline',
    'model_call_deadline', 'model_usage_unreported', 'model_usage_invalid',
    'model_usage_exceeded', 'model_outcome_uncertain', 'model_spend_limit',
    'model_payment_failure', 'model_restricted', 'model_provider_failure', 'model_contract_unknown',
    'repair_cycle_limit'
  )),
  actual_input_tokens integer CHECK (actual_input_tokens IS NULL OR actual_input_tokens >= 0),
  actual_output_tokens integer CHECK (actual_output_tokens IS NULL OR actual_output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, operation_key),
  CHECK (kind = 'model_call' OR expected_head_sha IS NOT NULL),
  CHECK (
    (owner_generation IS NULL AND reserved_input_tokens IS NULL
      AND reserved_output_tokens IS NULL AND requested_output_tokens IS NULL
      AND call_deadline_at IS NULL)
    OR (kind = 'model_call' AND owner_generation IS NOT NULL
      AND reserved_input_tokens IS NOT NULL AND reserved_output_tokens IS NOT NULL
      AND requested_output_tokens IS NOT NULL
      AND reserved_output_tokens <= requested_output_tokens
      AND call_deadline_at IS NOT NULL)
  ),
  CHECK (outcome_code IS NULL OR owner_generation IS NOT NULL),
  CHECK (
    (outcome_code IS NULL AND outcome_blocker_code IS NULL)
    OR (outcome_code = 'success' AND outcome_blocker_code IS NULL)
    OR (outcome_code IS NOT NULL AND outcome_code <> 'success'
      AND outcome_blocker_code IS NOT NULL)
  ),
  CHECK ((actual_input_tokens IS NULL) = (actual_output_tokens IS NULL)),
  CHECK (actual_input_tokens IS NULL OR outcome_code IS NOT NULL)
);

CREATE UNIQUE INDEX one_model_reservation_per_generation
  ON agent_worker.operations (run_id, owner_generation)
  WHERE kind = 'model_call' AND owner_generation IS NOT NULL;

CREATE TABLE agent_worker.events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_worker.runs(run_id),
  generation bigint NOT NULL CHECK (generation >= 0),
  event_type text NOT NULL CHECK (event_type IN (
    'tick_claimed', 'checkpointed', 'intent_created', 'lease_recovered',
    'lease_recovery_limit', 'run_terminal', 'model_call_reserved',
    'model_call_outcome', 'budget_stopped', 'repair_reserved',
    'repair_limit_reached'
  )),
  invocation_id text CHECK (
    invocation_id IS NULL OR invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  operation_id uuid REFERENCES agent_worker.operations(operation_id),
  state text CHECK (state IS NULL OR state IN (
    'claimed', 'generating_tests', 'waiting_red_ci', 'implementing',
    'waiting_ci', 'opening_pr', 'waiting_review', 'repairing',
    'ready_for_human', 'needs_attention', 'cancelled'
  )),
  repair_key text CHECK (repair_key IS NULL OR repair_key ~ '^[a-f0-9]{64}$'),
  repair_source text CHECK (repair_source IS NULL OR repair_source IN ('ci', 'qodo')),
  repair_head_sha text CHECK (repair_head_sha IS NULL OR repair_head_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (event_type IN ('repair_reserved', 'repair_limit_reached')
      AND repair_key IS NOT NULL AND repair_source IS NOT NULL AND repair_head_sha IS NOT NULL)
    OR (event_type NOT IN ('repair_reserved', 'repair_limit_reached')
      AND repair_key IS NULL AND repair_source IS NULL AND repair_head_sha IS NULL)
  ),
  CHECK (event_type NOT IN ('intent_created', 'model_call_reserved', 'model_call_outcome')
    OR operation_id IS NOT NULL)
);

CREATE UNIQUE INDEX one_event_per_invocation
  ON agent_worker.events (invocation_id)
  WHERE invocation_id IS NOT NULL;

CREATE UNIQUE INDEX one_event_per_repair_key
  ON agent_worker.events (run_id, repair_key)
  WHERE repair_key IS NOT NULL;

CREATE UNIQUE INDEX one_model_call_outcome_event
  ON agent_worker.events (operation_id)
  WHERE event_type = 'model_call_outcome';

COMMIT;
