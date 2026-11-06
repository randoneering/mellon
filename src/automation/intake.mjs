import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { hasReadyLabel, InputError, positiveId, readBytes, validRepository } from './http.mjs';
import { reportFailure } from './diagnostics.mjs';

const BODY_LIMIT = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

function response(status, httpStatus = 200) {
  return Response.json({ status }, { status: httpStatus, headers: { 'cache-control': 'no-store' } });
}

function authenticated(bytes, signature, secret) {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature ?? '')) return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(bytes).digest();
  return timingSafeEqual(received, expected);
}

function validateEvent(event, deliveryId) {
  if (!UUID.test(deliveryId ?? '') || !positiveId(event.repository?.id) ||
      typeof event.repository?.full_name !== 'string' ||
      !positiveId(event.issue?.id) || !positiveId(event.issue?.number) ||
      !positiveId(event.sender?.id) || typeof event.sender?.login !== 'string' ||
      typeof event.sender?.type !== 'string') throw new InputError(400);
}

export function createIntake({ secret, repository, github, store, report = line => console.error(line), requestTimeoutMs = 10000 }) {
  if (typeof secret !== 'string' || !secret || !validRepository(repository) ||
      !github || !store || typeof report !== 'function' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 10000) throw new Error('Invalid webhook intake configuration.');
  const configuredName = repository.fullName.toLowerCase();
  const repositoryUrl = `https://api.github.com/repos/${repository.fullName}`.toLowerCase();
  return async function handle(request) {
    if (new URL(request.url).pathname !== '/github') return response('not_found', 404);
    if (request.method !== 'POST') return response('method_not_allowed', 405);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        ![null, 'identity'].includes(request.headers.get('content-encoding'))) return response('unsupported_media_type', 415);
    let stage = 'request_read';
    let validatedDeliveryId = null;
    try {
      const bytes = await readBytes(request.body, BODY_LIMIT, requestTimeoutMs);
      if (!authenticated(bytes, request.headers.get('x-hub-signature-256'), secret)) return response('unauthorized', 401);
      stage = 'event_validation';
      let event;
      try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new InputError(400); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new InputError(400);
      const eventName = request.headers.get('x-github-event');
      if (!eventName) throw new InputError(400);
      if (eventName !== 'issues' || event.action !== 'labeled' ||
          typeof event.label?.name === 'string' && event.label.name.toLowerCase() !== 'agent: ready') return response('ignored');
      if (typeof event.label?.name !== 'string') throw new InputError(400);
      const deliveryId = request.headers.get('x-github-delivery');
      validateEvent(event, deliveryId);
      if (event.repository.id !== repository.id || event.repository.full_name.toLowerCase() !== configuredName ||
          event.sender.type !== 'User' || event.sender.login.toLowerCase() === 'ghost') return response('ignored');
      if (!LOGIN.test(event.sender.login)) throw new InputError(400);
      validatedDeliveryId = deliveryId;
      const bodyHash = createHash('sha256').update(bytes).digest('hex');
      stage = 'receipt_read';
      const receipt = await store.getDelivery(deliveryId);
      if (receipt) {
        if (receipt.bodyHash !== bodyHash) throw new InputError(400);
        return response('duplicate');
      }
      stage = 'permission_read';
      if (!await github.authorizeSender(event.sender)) return response('ignored');
      stage = 'issue_read';
      const issue = await github.readIssue(event.issue.number);
      if (issue.id !== event.issue.id || issue.number !== event.issue.number ||
          typeof issue.repository_url !== 'string' || issue.repository_url.toLowerCase() !== repositoryUrl) throw new Error('Issue identity could not be confirmed.');
      if (issue.state !== 'open' || Object.hasOwn(issue, 'pull_request') || !hasReadyLabel(issue.labels)) return response('ignored');
      stage = 'enqueue';
      const result = await store.enqueue({
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        issueId: issue.id,
        issueNumber: issue.number,
        actorId: event.sender.id,
        deliveryId,
        bodyHash,
      });
      return result.created ? response('queued', 202) : response('duplicate');
    } catch (error) {
      if (error instanceof InputError && error.status !== 503) {
        return response(error.status === 413 ? 'too_large' : 'invalid_request', error.status);
      }
      const category = stage === 'request_read' && error instanceof InputError && error.status === 503 ? 'request_timeout' :
        ['permission_read', 'issue_read'].includes(stage) ? 'github_unavailable' :
          ['receipt_read', 'enqueue'].includes(stage) ? 'persistence_unavailable' : 'handler_unavailable';
      reportFailure(report, category, stage, validatedDeliveryId);
      return response('unavailable', 503);
    }
  };
}
