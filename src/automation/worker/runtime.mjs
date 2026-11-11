import { createWorkerDatabase } from './pool.mjs';
import { createWorkerStore } from './store.mjs';
import { createGitHubAppBroker } from './github-app.mjs';
import { checkApproval } from './approval.mjs';
import { createCoordinator } from './coordinator.mjs';
import { createWaitDeadline } from './store-validation.mjs';
import { workerRuntimeEnvironment } from './environment.mjs';
import { readRuntimeConfiguration, authorizeRuntimeConfiguration } from './runtime-config.mjs';

export function createWorkerRuntime({ env, report, factories = {} }) {
  const config = readRuntimeConfiguration(env);
  const rawConfig = env.AGENT_WORKER_CONFIG_JSON;
  const configPin = env.AGENT_WORKER_CONFIG_SHA256;
  const databaseUrl = env.AGENT_WORKER_DATABASE_URL;
  const fetch = factories.fetch ?? globalThis.fetch;
  let credentials;
  let database;
  let budget;
  let coordinator;
  let authorizationStarted = false;
  let authorized = false;
  let advanced = false;
  let closed = false;
  function notice() {
    try { Promise.resolve(report?.('[agent_worker] runtime_preflight_unavailable')).catch(() => {}); } catch {}
  }
  function current() {
    return !closed && env.AGENT_WORKER_ENABLED === 'true'
      && env.NEON_BRANCH === config?.productionBranch
      && env.AGENT_WORKER_CONFIG_JSON === rawConfig
      && env.AGENT_WORKER_CONFIG_SHA256 === configPin
      && env.AGENT_WORKER_DATABASE_URL === databaseUrl
      && env.WORKER_MODEL_TOKEN === credentials?.apiKey
      && env.WORKER_MODEL_BASE_URL === credentials?.baseURL
      && env.AGENT_WORKER_APP_PRIVATE_KEY === credentials?.privateKey
      && Date.now() < (credentials?.expiresAt ?? 0);
  }
  async function authorizeRuntime() {
    if (authorizationStarted || closed) return false;
    authorizationStarted = true;
    try {
      credentials = authorizeRuntimeConfiguration(config, env);
      if (!current() || typeof fetch !== 'function') return false;
      budget = createWaitDeadline(config.manifest.limits.tickDeadlineSeconds * 1000);
      const broker = (factories.createBroker ?? createGitHubAppBroker)({
        ...config.github, repositoryId: config.manifest.repository.id,
        repositoryName: config.manifest.repository.name, privateKey: credentials.privateKey,
      }, { fetch });
      database = (factories.createDatabase ?? createWorkerDatabase)({
        env: workerRuntimeEnvironment(env, config.databaseRole),
        databaseRole: config.databaseRole, report,
      });
      await budget.wait(() => database.verifyRole({ signal: budget.signal,
        deadline: budget.deadline, limits: config.manifest.limits,
        ...(config.manifest.reviewPolicy ? { reviewRequests: true } : {}) }));
      if (!current()) return false;
      const readToken = await budget.wait(() => broker.getReadToken({
        signal: budget.signal, deadline: budget.deadline,
      }));
      const approved = await budget.wait(() => (factories.checkApproval ?? checkApproval)({
        manifest: config.manifest, expectedManifestSha256: config.manifestSha256,
        token: readToken, timeoutMs: Math.max(1, Math.min(5000, budget.deadline - Date.now())),
        fetch: (url, options) => budget.wait(() => fetch(url, { ...options,
          signal: AbortSignal.any([budget.signal, options.signal]),
        })),
      }));
      if (approved?.authorized !== true || !current()) return false;
      await budget.wait(() => broker.verifyRuntime({ signal: budget.signal, deadline: budget.deadline }));
      if (!current()) return false;
      const store = (factories.createStore ?? createWorkerStore)(database.pool);
      coordinator = (factories.createCoordinator ?? createCoordinator)({
        store, manifest: config.manifest, expectedManifestSha256: config.manifestSha256,
        policyManifest: config.policyManifest, triggerId: config.triggerId,
        readToken, ownedActor: config.github.actor, fetch, isEnabled: current,
        // Let the coordinator settle its ledger before the outer runtime closes the pool.
        deadline: budget.deadline - 1000,
        timeoutMs: Math.max(1, Math.min(90_000, budget.deadline - Date.now() - 1000)),
        model: {
          config: { gateway: { baseURL: credentials.baseURL, apiKey: credentials.apiKey },
            modelId: config.manifest.model.id, reasoningEffort: config.manifest.model.reasoningEffort,
            inputAdmission: config.manifest.model.inputAdmission },
          sdk: { fetch },
        },
        publicationDependencies: { fetch, getPublicationContext: broker.getPublicationContext,
          getPullRequestContext: broker.getPullRequestContext },
      });
      authorized = current();
      return authorized;
    } catch { notice(); return false; }
  }
  async function advanceTick(delivery) {
    if (!authorized || advanced || !current()) throw new Error('Worker runtime is unavailable.');
    advanced = true;
    return budget.wait(() => coordinator.advanceTick(delivery));
  }
  async function close() {
    if (closed) return;
    closed = true;
    budget?.close();
    try { await database?.close(); } catch { notice(); }
  }
  return Object.freeze({
    trustedConfig: config && { productionBranch: config.productionBranch,
      triggerId: config.triggerId, databaseRole: config.databaseRole },
    authorizeRuntime, advanceTick, close,
  });
}
