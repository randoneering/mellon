import { createHmac, randomUUID } from 'node:crypto';

export const webhookSecret = 'synthetic-test-webhook-secret';
export const repository = { id: 123, fullName: 'randoneering/mellon' };
export const deliveryId = '00000000-0000-4000-8000-000000000001';

export function issueEvent(overrides = {}) {
  return {
    action: 'labeled',
    repository: { id: 123, full_name: 'randoneering/mellon' },
    issue: { id: 456, number: 21, title: 'Private title', body: 'Private body' },
    label: { name: 'agent: ready' },
    sender: { id: 789, login: 'maintainer', type: 'User' },
    ...overrides,
  };
}

export function currentIssue(overrides = {}) {
  return {
    id: 456, number: 21, state: 'open',
    repository_url: 'https://api.github.com/repos/randoneering/mellon',
    labels: [{ name: 'agent: ready' }],
    ...overrides,
  };
}

export function signedRequest(payload = issueEvent(), options = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
  return new Request(options.url ?? 'https://intake.example/github', {
    method: options.method ?? 'POST',
    body: options.method === 'GET' ? undefined : body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
      ...options.headers,
    },
  });
}

export function jobRecord(overrides = {}) {
  return {
    repositoryId: 123, repositoryFullName: 'randoneering/mellon',
    issueId: 700, issueNumber: 42, actorId: 789,
    deliveryId: randomUUID(), bodyHash: 'a'.repeat(64),
    ...overrides,
  };
}

export function dependencies(overrides = {}) {
  const calls = [];
  const jobs = [];
  const logs = [];
  return {
    calls,
    jobs,
    logs,
    report: line => logs.push(line),
    secret: webhookSecret,
    repository,
    github: {
      async authorizeSender(sender) { calls.push(['authorize', sender.id]); return true; },
      async readIssue(number) { calls.push(['issue', number]); return currentIssue(); },
    },
    store: {
      async getDelivery(id) { calls.push(['receipt', id]); return null; },
      async enqueue(job) { jobs.push(job); return { created: true }; },
    },
    ...overrides,
  };
}
