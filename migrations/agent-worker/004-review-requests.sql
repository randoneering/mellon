BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE TABLE agent_worker.review_requests (
  run_id uuid NOT NULL REFERENCES agent_worker.runs(run_id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'),
  pull_request_number bigint NOT NULL CHECK (pull_request_number > 0),
  actor_id bigint NOT NULL CHECK (actor_id > 0),
  actor_login text NOT NULL CHECK (actor_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$'),
  app_id bigint NOT NULL CHECK (app_id > 0),
  identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[a-f0-9]{64}$'),
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  attempted boolean NOT NULL DEFAULT false,
  attempted_generation bigint CHECK (attempted_generation > 0),
  comment_id bigint CHECK (comment_id > 0),
  evidence_source text CHECK (evidence_source IN ('qodo', 'maintainer')),
  native_review_id bigint CHECK (native_review_id > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, head_sha),
  CHECK ((evidence_source IS NULL) = (native_review_id IS NULL)),
  CHECK (attempted = (attempted_generation IS NOT NULL)),
  CHECK (comment_id IS NULL OR attempted),
  CHECK (evidence_source IS NULL OR comment_id IS NOT NULL)
);

CREATE FUNCTION agent_worker.review_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'review request deletion is forbidden'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM agent_worker.runs r WHERE r.run_id=NEW.run_id
      AND r.repository_id=NEW.repository_id AND r.repository_full_name=NEW.repository_full_name
      AND r.pull_request_number=NEW.pull_request_number AND r.expected_head_sha=NEW.head_sha
      AND r.branch_name='agent-work/' || r.run_id::text AND r.generation=NEW.lease_generation
      AND r.state='waiting_review' AND r.pending_operation_id IS NULL AND r.terminal_at IS NULL
      AND r.last_check_head_sha=NEW.head_sha AND r.check_evidence_sha256 IS NOT NULL
      AND r.lease_expires_at > clock_timestamp()
      AND r.lease_started_at + ((r.limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second') > clock_timestamp()
      AND r.created_at + ((r.limits ->> 'runLifetimeSeconds')::double precision * interval '1 second') > clock_timestamp()
      AND r.wait_started_at + ((r.limits ->> 'reviewWaitSeconds')::double precision * interval '1 second') > clock_timestamp()
      AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=r.run_id
        AND o.kind='commit_create' AND o.effect_phase='confirmed' AND o.effect_reference=NEW.head_sha)
      AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=r.run_id
        AND o.kind='pr_create' AND o.effect_phase='confirmed' AND o.effect_reference=NEW.pull_request_number::text)
      FOR UPDATE;
    IF NOT FOUND OR NEW.attempted OR NEW.comment_id IS NOT NULL OR NEW.evidence_source IS NOT NULL THEN
      RAISE EXCEPTION 'review request parent binding is invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.run_id, NEW.head_sha, NEW.repository_id, NEW.repository_full_name,
         NEW.pull_request_number, NEW.actor_id, NEW.actor_login, NEW.app_id,
         NEW.identity_sha256, NEW.lease_generation)
     IS DISTINCT FROM
     ROW(OLD.run_id, OLD.head_sha, OLD.repository_id, OLD.repository_full_name,
         OLD.pull_request_number, OLD.actor_id, OLD.actor_login, OLD.app_id,
         OLD.identity_sha256, OLD.lease_generation)
     OR (OLD.attempted AND (NOT NEW.attempted
       OR NEW.attempted_generation IS DISTINCT FROM OLD.attempted_generation))
     OR (OLD.comment_id IS NOT NULL AND NEW.comment_id IS DISTINCT FROM OLD.comment_id)
     OR (OLD.evidence_source IS NOT NULL AND
         ROW(NEW.evidence_source, NEW.native_review_id) IS DISTINCT FROM
         ROW(OLD.evidence_source, OLD.native_review_id)) THEN
    RAISE EXCEPTION 'review request metadata is immutable';
  END IF;
  -- Attempt, confirmation and evidence must each build on a previously recorded stage.
  IF (NOT OLD.attempted AND (NEW.comment_id IS NOT NULL OR NEW.evidence_source IS NOT NULL))
     OR (OLD.comment_id IS NULL AND NEW.evidence_source IS NOT NULL) THEN
    RAISE EXCEPTION 'review request transition is invalid';
  END IF;
  PERFORM 1 FROM agent_worker.runs r WHERE r.run_id=NEW.run_id
    AND r.repository_id=NEW.repository_id AND r.repository_full_name=NEW.repository_full_name
    AND r.pull_request_number=NEW.pull_request_number AND r.expected_head_sha=NEW.head_sha
    AND r.branch_name='agent-work/' || r.run_id::text AND r.generation>=NEW.lease_generation
    AND (OLD.attempted OR NOT NEW.attempted OR NEW.attempted_generation=r.generation)
    AND r.state='waiting_review' AND r.pending_operation_id IS NULL AND r.terminal_at IS NULL
    AND r.last_check_head_sha=NEW.head_sha AND r.check_evidence_sha256 IS NOT NULL
    AND r.lease_expires_at > clock_timestamp()
    AND r.lease_started_at + ((r.limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second') > clock_timestamp()
    AND r.created_at + ((r.limits ->> 'runLifetimeSeconds')::double precision * interval '1 second') > clock_timestamp()
    AND r.wait_started_at + ((r.limits ->> 'reviewWaitSeconds')::double precision * interval '1 second') > clock_timestamp()
    AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=r.run_id
      AND o.kind='commit_create' AND o.effect_phase='confirmed' AND o.effect_reference=NEW.head_sha)
    AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=r.run_id
      AND o.kind='pr_create' AND o.effect_phase='confirmed' AND o.effect_reference=NEW.pull_request_number::text)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'review request update binding is invalid'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER review_request_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_worker.review_requests
  FOR EACH ROW EXECUTE FUNCTION agent_worker.review_request_guard();
CREATE INDEX review_requests_by_pr ON agent_worker.review_requests(repository_id, pull_request_number);
CREATE UNIQUE INDEX review_request_comment_identity ON agent_worker.review_requests(repository_id, comment_id)
  WHERE comment_id IS NOT NULL;

-- Grant SELECT, INSERT, UPDATE to the separately approved worker role at deployment.
-- Role names are configuration, not a test-role assumption in this migration.
COMMIT;
