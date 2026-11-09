BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE TYPE agent_worker.coordinator_purpose AS ENUM (
  'initial_tests', 'initial_implementation', 'repair_investigation',
  'repair_tests', 'repair_implementation', 'draft_pr'
);

ALTER TABLE agent_worker.operations
  ADD COLUMN coordinator_version smallint CHECK (coordinator_version = 1),
  ADD COLUMN phase_purpose agent_worker.coordinator_purpose,
  ADD COLUMN phase_key text CHECK (phase_key ~ '^[a-f0-9]{64}$'),
  ADD COLUMN phase_round smallint CHECK (phase_round BETWEEN 0 AND 2),
  ADD COLUMN model_operation_id uuid,
  ADD COLUMN descriptor_count smallint CHECK (descriptor_count BETWEEN 1 AND 10),
  ADD COLUMN regression_workflow_id bigint CHECK (regression_workflow_id > 0),
  ADD COLUMN regression_test_sha256 text CHECK (regression_test_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN regression_proposal_sha256 text CHECK (regression_proposal_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN criterion_sha256 text CHECK (criterion_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT operation_run_identity UNIQUE (run_id, operation_id),
  ADD CONSTRAINT operation_phase_identity UNIQUE (run_id, operation_id, phase_key, expected_head_sha),
  ADD CONSTRAINT operation_model_phase FOREIGN KEY (run_id, model_operation_id, phase_key, expected_head_sha)
    REFERENCES agent_worker.operations (run_id, operation_id, phase_key, expected_head_sha),
  ADD CONSTRAINT operation_coordinator_pair CHECK (
    (coordinator_version IS NULL AND phase_purpose IS NULL AND phase_key IS NULL
      AND phase_round IS NULL AND model_operation_id IS NULL AND descriptor_count IS NULL
      AND regression_workflow_id IS NULL AND regression_test_sha256 IS NULL
      AND regression_proposal_sha256 IS NULL AND criterion_sha256 IS NULL)
    OR (coordinator_version IS NOT NULL AND phase_purpose IS NOT NULL
      AND phase_key IS NOT NULL AND phase_round IS NOT NULL AND expected_head_sha IS NOT NULL
      AND ((phase_purpose IN ('initial_tests', 'initial_implementation') AND phase_round = 0)
        OR (phase_purpose IN ('repair_investigation', 'repair_tests', 'repair_implementation') AND phase_round IN (1, 2))
        OR phase_purpose = 'draft_pr')
      AND ((kind = 'model_call' AND model_operation_id IS NULL AND descriptor_count IS NULL)
        OR (kind = 'commit_create' AND model_operation_id IS NOT NULL AND descriptor_count IS NOT NULL
          AND phase_purpose IN ('initial_tests', 'initial_implementation', 'repair_tests', 'repair_implementation'))
        OR (kind = 'pr_create' AND model_operation_id IS NULL AND descriptor_count IS NULL AND phase_purpose = 'draft_pr')))
  ),
  ADD CONSTRAINT operation_regression_pair CHECK (
    (regression_workflow_id IS NULL AND regression_test_sha256 IS NULL AND regression_proposal_sha256 IS NULL)
    OR (regression_workflow_id IS NOT NULL AND regression_test_sha256 IS NOT NULL AND regression_proposal_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT regression_publication_binding CHECK (
    coordinator_version IS NULL OR kind <> 'commit_create'
    OR phase_purpose NOT IN ('initial_tests', 'repair_tests')
    OR (regression_workflow_id IS NOT NULL AND criterion_sha256 IS NOT NULL
      AND regression_proposal_sha256 = input_hash)
  );

CREATE UNIQUE INDEX one_model_per_coordinator_phase ON agent_worker.operations (run_id, phase_key)
  WHERE coordinator_version = 1 AND kind = 'model_call';
CREATE UNIQUE INDEX one_effect_per_coordinator_phase ON agent_worker.operations (run_id, phase_key)
  WHERE coordinator_version = 1 AND kind IN ('commit_create', 'pr_create');

ALTER TABLE agent_worker.runs
  ADD COLUMN coordinator_version smallint CHECK (coordinator_version = 1),
  ADD COLUMN phase_purpose agent_worker.coordinator_purpose,
  ADD COLUMN phase_key text CHECK (phase_key ~ '^[a-f0-9]{64}$'),
  ADD COLUMN phase_round smallint CHECK (phase_round BETWEEN 0 AND 2),
  ADD COLUMN phase_head_sha text CHECK (phase_head_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN phase_started_at timestamptz,
  ADD COLUMN wait_started_at timestamptz,
  ADD COLUMN pending_operation_id uuid,
  ADD COLUMN regression_workflow_id bigint CHECK (regression_workflow_id > 0),
  ADD COLUMN regression_test_sha256 text CHECK (regression_test_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN regression_proposal_sha256 text CHECK (regression_proposal_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN criterion_sha256 text CHECK (criterion_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN finding_sha256 text CHECK (finding_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN finding_source text CHECK (finding_source IN ('ci', 'qodo')),
  ADD COLUMN finding_head_sha text CHECK (finding_head_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN prior_check_run_id bigint CHECK (prior_check_run_id > 0),
  ADD COLUMN prior_review_id bigint CHECK (prior_review_id > 0),
  ADD COLUMN last_check_head_sha text CHECK (last_check_head_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN last_workflow_id bigint CHECK (last_workflow_id > 0),
  ADD COLUMN last_workflow_run_id bigint CHECK (last_workflow_run_id > 0),
  ADD COLUMN check_evidence_sha256 text CHECK (check_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT check_evidence_pair CHECK (
    (last_check_head_sha IS NULL AND last_workflow_id IS NULL
      AND last_workflow_run_id IS NULL AND check_evidence_sha256 IS NULL)
    OR (coordinator_version IS NOT NULL AND coordinator_version = 1
      AND last_check_head_sha IS NOT NULL AND last_workflow_id IS NOT NULL
      AND last_workflow_run_id IS NOT NULL AND check_evidence_sha256 IS NOT NULL
      AND last_check_run_id IS NOT NULL)
  ),
  ADD CONSTRAINT coordinator_ready_evidence CHECK (
    coordinator_version IS DISTINCT FROM 1 OR state <> 'ready_for_human'
    OR (phase_purpose IS NOT NULL AND phase_purpose = 'draft_pr'
      AND pending_operation_id IS NULL AND expected_head_sha IS NOT NULL
      AND last_check_head_sha IS NOT NULL AND last_check_head_sha = expected_head_sha
      AND review_head_sha IS NOT NULL AND review_head_sha = expected_head_sha
      AND last_check_run_id IS NOT NULL AND prior_check_run_id IS NOT NULL
      AND prior_check_run_id = last_check_run_id AND prior_review_id IS NOT NULL
      AND last_workflow_id IS NOT NULL AND regression_workflow_id IS NOT NULL
      AND last_workflow_id = regression_workflow_id AND check_evidence_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT pending_same_phase FOREIGN KEY (run_id, pending_operation_id, phase_key, phase_head_sha)
    REFERENCES agent_worker.operations (run_id, operation_id, phase_key, expected_head_sha),
  ADD CONSTRAINT run_coordinator_pair CHECK (
    (coordinator_version IS NULL AND phase_purpose IS NULL AND phase_key IS NULL
      AND phase_round IS NULL AND phase_head_sha IS NULL AND phase_started_at IS NULL
      AND wait_started_at IS NULL AND pending_operation_id IS NULL
      AND regression_workflow_id IS NULL AND regression_test_sha256 IS NULL
      AND regression_proposal_sha256 IS NULL AND criterion_sha256 IS NULL
      AND finding_sha256 IS NULL AND finding_source IS NULL AND finding_head_sha IS NULL
      AND prior_check_run_id IS NULL AND prior_review_id IS NULL)
    OR (coordinator_version IS NOT NULL AND phase_purpose IS NOT NULL
      AND phase_key IS NOT NULL AND phase_round IS NOT NULL AND phase_head_sha IS NOT NULL
      AND phase_started_at IS NOT NULL AND phase_round = repair_cycle_count
      AND ((phase_purpose IN ('initial_tests', 'initial_implementation') AND phase_round = 0)
        OR (phase_purpose IN ('repair_investigation', 'repair_tests', 'repair_implementation')
          AND phase_round IN (1, 2) AND finding_sha256 IS NOT NULL)
        OR phase_purpose = 'draft_pr'))
  ),
  ADD CONSTRAINT run_regression_pair CHECK (
    (regression_workflow_id IS NULL AND regression_test_sha256 IS NULL AND regression_proposal_sha256 IS NULL)
    OR (regression_workflow_id IS NOT NULL AND regression_test_sha256 IS NOT NULL AND regression_proposal_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT run_finding_pair CHECK (
    (finding_sha256 IS NULL AND finding_source IS NULL AND finding_head_sha IS NULL)
    OR (finding_sha256 IS NOT NULL AND finding_source IS NOT NULL AND finding_head_sha IS NOT NULL)
  );

ALTER TABLE agent_worker.events
  ADD COLUMN repair_finding_sha256 text CHECK (repair_finding_sha256 ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX one_repair_per_finding ON agent_worker.events
  (run_id, repair_source, repair_head_sha, repair_finding_sha256)
  WHERE repair_finding_sha256 IS NOT NULL;

CREATE TABLE agent_worker.candidate_descriptors (
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  approved_path_index integer NOT NULL CHECK (approved_path_index >= 0),
  change_kind text NOT NULL CHECK (change_kind IN ('create', 'modify')),
  before_blob_sha text CHECK (before_blob_sha ~ '^[a-f0-9]{40}$'),
  after_blob_sha text NOT NULL CHECK (after_blob_sha ~ '^[a-f0-9]{40}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 0 AND 65536),
  file_mode text NOT NULL CHECK (file_mode = '100644'),
  PRIMARY KEY (operation_id, ordinal),
  UNIQUE (operation_id, approved_path_index),
  FOREIGN KEY (run_id, operation_id) REFERENCES agent_worker.operations (run_id, operation_id),
  CHECK ((change_kind = 'create' AND before_blob_sha IS NULL)
    OR (change_kind = 'modify' AND before_blob_sha IS NOT NULL))
);

-- Deferred validation permits atomic insertion of the operation and its descriptors.
-- Runtime needs no UPDATE/DELETE grant on descriptor rows.
CREATE FUNCTION agent_worker.valid_coordinator_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, agent_worker AS $function$
DECLARE
  candidate agent_worker.operations%ROWTYPE;
  model agent_worker.operations%ROWTYPE;
  count_files integer;
  total_bytes bigint;
BEGIN
  SELECT * INTO candidate FROM agent_worker.operations
    WHERE operation_id = NEW.operation_id FOR UPDATE;
  IF candidate.coordinator_version IS NULL THEN
    IF TG_TABLE_NAME = 'candidate_descriptors' THEN
      RAISE EXCEPTION 'Invalid coordinator candidate';
    END IF;
    RETURN NEW;
  END IF;
  SELECT count(*), COALESCE(sum(byte_count), 0) INTO count_files, total_bytes
    FROM agent_worker.candidate_descriptors WHERE operation_id = NEW.operation_id;
  IF candidate.coordinator_version = 1 AND candidate.kind = 'commit_create' THEN
    SELECT * INTO model FROM agent_worker.operations WHERE operation_id = candidate.model_operation_id;
    IF count_files NOT BETWEEN 1 AND 10 OR count_files <> candidate.descriptor_count OR total_bytes > 262144
        OR model.kind IS DISTINCT FROM 'model_call' OR model.outcome_code IS DISTINCT FROM 'success'
        OR model.run_id IS DISTINCT FROM candidate.run_id
        OR model.phase_key IS DISTINCT FROM candidate.phase_key
        OR model.phase_purpose IS DISTINCT FROM candidate.phase_purpose
        OR model.phase_round IS DISTINCT FROM candidate.phase_round
        OR model.expected_head_sha IS DISTINCT FROM candidate.expected_head_sha THEN
      RAISE EXCEPTION 'Invalid coordinator candidate';
    END IF;
  ELSIF count_files <> 0 THEN
    RAISE EXCEPTION 'Invalid coordinator candidate';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER coordinator_candidate_operation
  AFTER INSERT OR UPDATE ON agent_worker.operations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION agent_worker.valid_coordinator_candidate();
CREATE CONSTRAINT TRIGGER coordinator_candidate_files
  AFTER INSERT OR UPDATE ON agent_worker.candidate_descriptors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION agent_worker.valid_coordinator_candidate();

CREATE FUNCTION agent_worker.immutable_coordinator_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, agent_worker AS $function$
BEGIN
  IF TG_TABLE_NAME = 'candidate_descriptors' THEN
    RAISE EXCEPTION 'Coordinator descriptors are immutable';
  END IF;
  IF OLD.coordinator_version IS NOT NULL AND OLD.outcome_code IS NOT NULL
      AND ROW(OLD.outcome_code, OLD.outcome_blocker_code, OLD.actual_input_tokens, OLD.actual_output_tokens)
        IS DISTINCT FROM ROW(NEW.outcome_code, NEW.outcome_blocker_code, NEW.actual_input_tokens, NEW.actual_output_tokens) THEN
    RAISE EXCEPTION 'Coordinator model outcome is immutable';
  END IF;
  IF OLD.coordinator_version IS NOT NULL AND ROW(
    OLD.run_id, OLD.operation_key, OLD.kind, OLD.input_hash, OLD.expected_head_sha,
    OLD.coordinator_version, OLD.phase_purpose, OLD.phase_key, OLD.phase_round,
    OLD.model_operation_id, OLD.descriptor_count, OLD.regression_workflow_id, OLD.regression_test_sha256,
    OLD.regression_proposal_sha256, OLD.criterion_sha256
  ) IS DISTINCT FROM ROW(
    NEW.run_id, NEW.operation_key, NEW.kind, NEW.input_hash, NEW.expected_head_sha,
    NEW.coordinator_version, NEW.phase_purpose, NEW.phase_key, NEW.phase_round,
    NEW.model_operation_id, NEW.descriptor_count, NEW.regression_workflow_id, NEW.regression_test_sha256,
    NEW.regression_proposal_sha256, NEW.criterion_sha256
  ) THEN
    RAISE EXCEPTION 'Coordinator operation identity is immutable';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER immutable_coordinator_operation BEFORE UPDATE ON agent_worker.operations
  FOR EACH ROW EXECUTE FUNCTION agent_worker.immutable_coordinator_identity();
CREATE TRIGGER immutable_coordinator_descriptors BEFORE UPDATE OR DELETE ON agent_worker.candidate_descriptors
  FOR EACH ROW EXECUTE FUNCTION agent_worker.immutable_coordinator_identity();

CREATE FUNCTION agent_worker.valid_pending_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, agent_worker AS $function$
BEGIN
  IF NEW.pending_operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_worker.operations
    WHERE run_id = NEW.run_id AND operation_id = NEW.pending_operation_id
      AND coordinator_version = 1 AND phase_key = NEW.phase_key
      AND phase_purpose = NEW.phase_purpose AND phase_round = NEW.phase_round
      AND expected_head_sha = NEW.phase_head_sha AND kind IN ('commit_create', 'pr_create')
  ) THEN
    RAISE EXCEPTION 'Invalid coordinator pending operation';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER coordinator_pending_operation BEFORE INSERT OR UPDATE ON agent_worker.runs
  FOR EACH ROW EXECUTE FUNCTION agent_worker.valid_pending_operation();

ALTER TABLE agent_worker.runs DROP CONSTRAINT runs_blocker_code_check;
ALTER TABLE agent_worker.runs ADD CONSTRAINT runs_blocker_code_check CHECK (
  blocker_code IS NULL OR blocker_code IN (
    'lease_recovery_limit', 'model_call_budget_exhausted', 'model_token_budget_exhausted',
    'model_input_token_limit', 'model_tick_deadline', 'model_run_deadline',
    'model_call_deadline', 'model_usage_unreported', 'model_usage_invalid',
    'model_usage_exceeded', 'model_outcome_uncertain', 'model_spend_limit',
    'model_payment_failure', 'model_restricted', 'model_provider_failure',
    'model_contract_unknown', 'repair_cycle_limit',
    'recovery_database_uncertain', 'recovery_effect_unconfirmed',
    'recovery_conflict', 'recovery_approval_denied', 'recovery_lease_lost',
    'recovery_deadline', 'recovery_unsupported_effect', 'recovery_invalid_input',
    'coordinator_pending_effect', 'coordinator_model_uncertain',
    'coordinator_candidate_lost', 'coordinator_journal_conflict', 'coordinator_wait_expired',
    'coordinator_investigation_human_stop'
  )
);

COMMIT;
