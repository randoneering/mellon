BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE SCHEMA agent_intake;

CREATE TABLE agent_intake.jobs (
    job_id uuid PRIMARY KEY,
    repository_id bigint NOT NULL CHECK (repository_id > 0),
    repository_full_name text NOT NULL CHECK (
        repository_full_name ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'
    ),
    issue_id bigint NOT NULL CHECK (issue_id > 0),
    issue_number bigint NOT NULL CHECK (issue_number > 0),
    actor_id bigint NOT NULL CHECK (actor_id > 0),
    initial_delivery_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status = 'queued'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, issue_id)
);

CREATE TABLE agent_intake.deliveries (
    delivery_id uuid PRIMARY KEY,
    body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
    job_id uuid NOT NULL REFERENCES agent_intake.jobs (job_id),
    received_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
