const CATEGORIES = new Set(['github_unavailable', 'persistence_unavailable', 'request_timeout', 'configuration_invalid', 'handler_unavailable']);
const STAGES = new Set(['request_read', 'event_validation', 'receipt_read', 'permission_read', 'issue_read', 'enqueue', 'configuration', 'initialization', 'handler', 'pool']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConfigurationError extends Error {
  constructor() {
    super('Invalid intake Function configuration.');
  }
}

export function reportFailure(report, category, stage, deliveryId = null) {
  const record = {
    category: CATEGORIES.has(category) ? category : 'handler_unavailable',
    stage: STAGES.has(stage) ? stage : 'handler',
    deliveryId: typeof deliveryId === 'string' && UUID.test(deliveryId) ? deliveryId : null,
  };
  // Diagnostics must never change the safe HTTP outcome if the log sink fails.
  try { report(JSON.stringify(record)); } catch {}
}
