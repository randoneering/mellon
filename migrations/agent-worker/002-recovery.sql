BEGIN;

-- A lost COMMIT reply must never reauthorize a publication phase.
ALTER TABLE agent_worker.operations
  ADD COLUMN effect_phase text NOT NULL DEFAULT 'prepared'
    CHECK (effect_phase IN ('prepared', 'confirmed')),
  ADD COLUMN effect_reference text,
  ADD COLUMN branch_attempted boolean NOT NULL DEFAULT false,
  ADD COLUMN commit_attempted boolean NOT NULL DEFAULT false,
  ADD COLUMN pr_attempted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT typed_publication_confirmation CHECK (
    (effect_phase = 'prepared' AND effect_reference IS NULL)
    OR (kind = 'commit_create' AND effect_phase = 'confirmed'
      AND effect_reference IS NOT NULL AND effect_reference ~ '^[a-f0-9]{40}$')
    OR (kind = 'pr_create' AND effect_phase = 'confirmed'
      AND effect_reference IS NOT NULL AND effect_reference ~ '^[1-9][0-9]{0,15}$')
  ),
  ADD CONSTRAINT publication_attempt_kinds CHECK (
    ((NOT branch_attempted AND NOT commit_attempted) OR kind = 'commit_create')
    AND (NOT pr_attempted OR kind = 'pr_create')
  );

-- Rekeying an uncertain effect must not create another execution slot.
CREATE UNIQUE INDEX one_commit_intent_per_parent
  ON agent_worker.operations (run_id, expected_head_sha) WHERE kind = 'commit_create';
CREATE UNIQUE INDEX one_branch_intent_per_run
  ON agent_worker.operations (run_id) WHERE kind = 'branch_create';
CREATE UNIQUE INDEX one_pr_intent_per_run
  ON agent_worker.operations (run_id) WHERE kind = 'pr_create';

-- Preserve every existing category while adding fixed recovery stops.
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
    'recovery_deadline', 'recovery_unsupported_effect', 'recovery_invalid_input'
  )
);

COMMIT;
