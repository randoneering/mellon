let nextRequest = 0;
const RPC_ERROR = 'Offline worker RPC failed.';
const PROVIDER_ERROR = 'Offline worker provider state rejected.';
const ARGS = '--no-approve --no-mcp --no-extensions';

export function effectRequest(socket, tag, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = String(++nextRequest);
    const clean = () => {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', failed);
      socket.removeListener('close', failed);
    };
    const failed = () => { clean(); reject(new Error(RPC_ERROR)); };
    const onMessage = data => {
      try {
        const text = data.toString();
        if (text.length > 2 * 1024 * 1024) return failed();
        const decoded = JSON.parse(text);
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message?._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
          if (message?._tag !== 'Exit' || String(message.requestId) !== id) continue;
          if (message.exit?._tag !== 'Success') return failed();
          clean();
          resolve(message.exit.value);
          return;
        }
      } catch { failed(); }
    };
    const timer = setTimeout(failed, timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', failed);
    socket.on('close', failed);
    try {
      socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    } catch { failed(); }
  });
}

function rejected(code = 'provider_shape') {
  const error = new Error(PROVIDER_ERROR);
  error.code = code;
  throw error;
}

function checkedProviders(config) {
  if (!Array.isArray(config?.providers) || !config.providers.length
      || !config.settings?.providerInstances
      || typeof config.settings.providerInstances !== 'object'
      || Array.isArray(config.settings.providerInstances)) rejected();
  const seen = new Set();
  for (const provider of config.providers) {
    if (typeof provider?.driver !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(provider.driver)
        || provider.instanceId !== provider.driver || seen.has(provider.instanceId)) rejected();
    seen.add(provider.instanceId);
  }
  if (!seen.has('pi')) rejected();
  return config.providers;
}

export function providerPatch(config) {
  const providers = checkedProviders(config);
  if (Object.keys(config.settings.providerInstances).length) rejected();
  const map = Object.create(null);
  for (const provider of providers) {
    map[provider.instanceId] = { driver: provider.driver, enabled: false, config: { enabled: false } };
  }
  map.pi = {
    driver: 'pi', enabled: true,
    environment: [{ name: 'PI_CODING_AGENT_DIR', value: '/worker-state/pi-agent', sensitive: false }],
    config: { enabled: true, binaryPath: '/opt/pi/node_modules/.bin/pi', launchArgs: ARGS },
  };
  return { patch: { providerInstances: map } };
}

export function providerDiagnostics(config) {
  const pi = config?.providers?.find(p => p.instanceId === 'pi');
  const message = typeof pi?.message === 'string' ? pi.message : '';
  const categories = [
    [/GLIBC|shared librar/i, 'runtime_dependency'],
    [/EACCES|permission denied/i, 'permission_denied'],
    [/not found|ENOENT/i, 'missing_executable'],
    [/RPC|discovery|inventory/i, 'inventory_failed'],
    [/no models|not authenticated|log in/i, 'model_auth_absent'],
  ];
  let rejection = null;
  try { providerEvidence(config); } catch (error) { rejection = error.code ?? 'provider_shape'; }
  const entry = config?.settings?.providerInstances?.pi;
  return {
    rejection,
    configurationChecks: {
      driverMatches: entry?.driver === 'pi',
      envelopeEnabled: entry?.enabled === true,
      configEnabled: entry?.config?.enabled === true,
      binaryMatches: entry?.config?.binaryPath === '/opt/pi/node_modules/.bin/pi',
      argumentsMatch: entry?.config?.launchArgs === ARGS,
      otherProvidersDisabled: config?.providers?.every(p => p.instanceId === 'pi' || p.enabled === false) === true,
      otherSettingsDisabled: Object.entries(config?.settings?.providerInstances ?? {}).every(([id, value]) => id === 'pi' || (value.enabled === false && (value.config?.enabled === undefined || value.config.enabled === false))),
    },
    piEnabled: pi?.enabled === true,
    piInstalled: pi?.installed === true,
    piVersion: /^[0-9]+\.[0-9]+\.[0-9]+$/.test(pi?.version ?? '') ? pi.version : null,
    piStatus: ['ready', 'warning', 'error', 'disabled'].includes(pi?.status) ? pi.status : 'unknown',
    piAuth: ['authenticated', 'unauthenticated', 'unknown'].includes(pi?.auth?.status) ? pi.auth.status : 'unknown',
    messageCategory: categories.find(([pattern]) => pattern.test(message))?.[1] ?? 'unclassified',
  };
}

export function providerEvidence(config) {
  const providers = checkedProviders(config);
  const pi = providers.find(p => p.instanceId === 'pi');
  const settings = config.settings.providerInstances;
  if (providers.some(p => p.instanceId !== 'pi' && p.enabled !== false)) rejected('unexpected_enabled_provider');
  if (pi.enabled !== true) rejected('pi_disabled');
  if (pi.installed !== true || pi.version !== '1.5.2') rejected('pi_installation');
  if (pi.status !== 'warning' || pi.auth?.status !== 'unauthenticated') rejected('pi_inventory');
  if (settings.pi?.driver !== 'pi' || settings.pi.enabled !== true
      || (settings.pi.config?.enabled !== undefined && settings.pi.config.enabled !== true)
      || settings.pi.config?.binaryPath !== '/opt/pi/node_modules/.bin/pi'
      || settings.pi.config.launchArgs !== ARGS) rejected('pi_configuration');
  for (const [id, entry] of Object.entries(settings)) {
    if (id !== 'pi' && (entry.enabled !== false
        || (entry.config?.enabled !== undefined && entry.config.enabled !== false))) rejected('disabled_provider_configuration');
  }
  return {
    piInstalled: true, piVersion: pi.version, piStatus: pi.status,
    piAuth: pi.auth.status, rpcInventoryVerified: true,
    enabledProviders: ['pi'],
  };
}
