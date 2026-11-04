import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitHubClient } from './github.mjs';
import { moderate } from './moderation.mjs';

const EVENT_LIMIT = 4 * 1024 * 1024;
const OUTCOMES = new Set(['skipped', 'empty_input', 'below_cutoff', 'closed', 'commented', 'flagged', 'error']);
const ACTION_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const ASSET_DIGESTS = new Map([
  ['preprocess.mjs', '14c86ef36a82cf603ef8120e5c4cc96a30ec0427650ca42ff20d3eb1217db984'],
  ['classifier.mjs', '6708c47a4fdf4dfa4b5034c4d2ea9bfacf37a59baae0b762e1b6e670e5a53f75'],
]);

function operationalError() {
  return new Error('Action failed safely.');
}

async function readEventFile(filename) {
  if (typeof filename !== 'string' || !filename) throw operationalError();
  let handle;
  try {
    handle = await open(filename, 'r');
    const buffer = Buffer.alloc(EVENT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > EVENT_LIMIT) throw operationalError();
    const bytes = buffer.subarray(0, bytesRead);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw operationalError();
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw operationalError();
    }
    return { payload, eventBytes: bytes };
  } finally {
    await handle?.close();
  }
}

export function formatOutputs(result) {
  if (!result || !OUTCOMES.has(result.outcome)) throw operationalError();
  let output = `outcome=${result.outcome}\n`;
  const score = result.robotScore;
  if (score !== undefined && score !== null) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw operationalError();
    }
    output += `robot-score=${String(score)}\n`;
  }
  return output;
}

async function writeOutputs(filename, content) {
  if (typeof filename !== 'string' || !filename) throw operationalError();
  try {
    const handle = await open(filename, 'a');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  } catch {
    throw operationalError();
  }
}

function normalizeResult(result) {
  const hasScore = result && Object.hasOwn(result, 'score') && result.score !== null;
  const score = hasScore && typeof result.score === 'number' && Number.isFinite(result.score)
    && result.score >= 0 && result.score <= 1 ? result.score : undefined;
  if (hasScore && score === undefined) throw operationalError();
  const normalized = {
    outcome: result?.outcome,
    ...(result?.outcome_labels_incomplete === true ? { outcomeLabelsIncomplete: true } : {}),
    ...(score === undefined ? {} : { robotScore: score }),
    ...(result?.outcome === 'flagged' ? { labelApplied: result.label_applied === true } : {}),
    ...(result?.outcome === 'error' || result?.outcome === 'skipped' && result.partial === true
      ? { partial: result.partial === true, commentId: validCommentId(result.comment_id),
        uncertainty: result.uncertainty === true, provenance: validProvenance(result) } : {}),
  };
  formatOutputs(normalized);
  return normalized;
}

function validCommentId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validProvenance(result) {
  if (typeof result?.detector_revision !== 'string' || !/^[a-f0-9]{40}$/.test(result.detector_revision) ||
      typeof result?.model_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.model_sha256) ||
      typeof result?.input_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.input_sha256)) return undefined;
  return { detectorRevision: result.detector_revision, modelSha256: result.model_sha256,
    inputSha256: result.input_sha256 };
}

async function packagedScore(request, detectorRoot) {
  try {
    const manifest = JSON.parse(await readFile(path.join(detectorRoot, 'provenance.json'), 'utf8'));
    const vendor = path.join(detectorRoot, 'vendor/aicomment');
    for (const asset of manifest.assets) {
      const bytes = await readFile(path.join(vendor, asset.path));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== asset.sha256 || ASSET_DIGESTS.has(asset.path) && digest !== ASSET_DIGESTS.get(asset.path)) {
        throw operationalError();
      }
    }
    const [{ default: winkNLP }, { default: languageModel }] = await Promise.all([
      import('wink-nlp'), import('wink-eng-lite-web-model'),
    ]);
    const { preprocess } = await import(pathToFileURL(path.join(vendor, 'preprocess.mjs')).href);
    const classifier = await import(pathToFileURL(path.join(vendor, 'classifier.mjs')).href);
    const nlp = winkNLP(languageModel);
    const prose = preprocess(request.text, '');
    const inputHash = createHash('sha256').update(prose, 'utf8').digest('hex');
    const result = {
      protocol_version: 1,
      detector_revision: manifest.detector_revision,
      model_sha256: manifest.model_sha256,
      input_sha256: inputHash,
    };
    const model = JSON.parse(await readFile(path.join(vendor, 'model.json'), 'utf8'));
    const body = prose.slice(model.markers.open.length, -model.markers.close.length);
    if (!body.trim()) return { ...result, outcome: 'empty_input' };
    const prepared = classifier.prepareModel(model);
    const tokenizers = classifier.tokenizersFor(prepared,
      text => nlp.readDoc(text).tokens().out(nlp.its.pos));
    const classified = classifier.classify(prepared, tokenizers, prose);
    const groups = classifier.collapseProbs(
      classifier.perClass(prepared, classified.probs), classifier.HUMAN_VS_ROBOT,
    );
    const human = groups.find(([label]) => label === 'human');
    const robotScore = human ? 1 - human[1] : Number.NaN;
    if (!Number.isFinite(robotScore) || robotScore < 0 || robotScore > 1) throw operationalError();
    return { ...result, outcome: 'classified', robot_score: robotScore };
  } catch {
    throw operationalError();
  }
}

export async function runAction({
  env = process.env,
  getuid = process.getuid,
  getInput,
  fetchImpl = fetch,
  score,
  readEvent = readEventFile,
  writeOutput = writeOutputs,
  actionDirectory = ACTION_DIRECTORY,
  includeSummary = true,
} = {}) {
  let result;
  try {
    if (typeof getuid !== 'function' || getuid() === 0) throw operationalError();
    const eventName = env.GITHUB_EVENT_NAME;
    const repository = env.GITHUB_REPOSITORY;
    if (eventName !== 'issues' && eventName !== 'pull_request_target') {
      result = { outcome: 'skipped' };
    } else {
      const { payload, eventBytes } = await readEvent(env.GITHUB_EVENT_PATH);
      const getContext = () => ({ eventName, repository, payload, eventBytes });
      const getInputs = () => {
        const allowlist = typeof getInput === 'function' ? getInput('allowlist') : '';
        const response = typeof getInput === 'function' ? getInput('response') : '';
        const mode = typeof getInput === 'function' ? getInput('mode') : '';
        const autoClose = typeof getInput === 'function' ? getInput('auto-close') : '';
        const reviewLabel = typeof getInput === 'function' ? getInput('review-label') : '';
        return {
          ...(allowlist === '' ? {} : { allowlist }),
          ...(response === '' ? {} : { response }),
          ...(mode === '' ? {} : { mode }),
          ...(autoClose === '' ? {} : { autoClose }),
          ...(reviewLabel === '' ? {} : { reviewLabel }),
        };
      };
      let api;
      const lazyApi = () => {
        if (api) return api;
        const token = typeof getInput === 'function' ? getInput('token') : '';
        if (typeof token !== 'string' || token.length === 0) throw operationalError();
        api = createGitHubClient({ token, fetchImpl, timeoutMs: 30_000 });
        return api;
      };
      const candidateApi = {
        listComments: (...args) => lazyApi().listComments(...args),
        getItem: (...args) => lazyApi().getItem(...args),
        getItemLabels: (...args) => lazyApi().getItemLabels(...args),
        createComment: (...args) => lazyApi().createComment(...args),
        closeItem: (...args) => lazyApi().closeItem(...args),
        getReviewLabel: (...args) => lazyApi().getReviewLabel(...args),
        createReviewLabel: (...args) => lazyApi().createReviewLabel(...args),
        getOutcomeLabel: (...args) => lazyApi().getOutcomeLabel(...args),
        createOutcomeLabel: (...args) => lazyApi().createOutcomeLabel(...args),
        addLabel: (...args) => lazyApi().addLabel(...args),
      };
      result = await moderate({
        getContext,
        getInputs,
        api: candidateApi,
        score: score ?? (request => packagedScore(request, path.join(actionDirectory, 'detector'))),
      });
    }
  } catch {
    result = { outcome: 'error' };
  }

  let safe;
  try {
    safe = normalizeResult(result);
    await writeOutput(env.GITHUB_OUTPUT, formatOutputs(safe));
    if (includeSummary) await writeSummary(env.GITHUB_STEP_SUMMARY, safe);
  } catch {
    safe = { outcome: 'error' };
    try {
      await writeOutput(env.GITHUB_OUTPUT, formatOutputs(safe));
    } catch {
      // A failed runner output write remains an operational failure.
    }
  }
  return safe;
}

async function writeSummary(filename, result) {
  if (typeof filename !== 'string' || !filename) return;
  const labels = {
    skipped: 'Skipped', empty_input: 'No prose to classify',
    below_cutoff: 'Below moderation cutoff', closed: 'Closed after confirmed response',
    commented: 'Response posted; submission remains open',
    flagged: 'Flagged for review', error: 'Operational error',
  };
  const score = result.robotScore === undefined ? '' : `\n\nRobot score: ${result.robotScore}.`;
  const partial = result.partial
    ? `\n\nResponse confirmed: yes\nClosure completed: no${result.commentId === undefined ? '' : `\nComment ID: ${result.commentId}`}${result.provenance ? `\nDetector revision: ${result.provenance.detectorRevision}\nModel SHA-256: ${result.provenance.modelSha256}\nInput SHA-256: ${result.provenance.inputSha256}` : ''}`
    : '';
  const labelNote = result.outcome === 'flagged' && result.labelApplied
    ? '\n\nLabel: mellon: review' : '';
  const uncertainty = result.outcome === 'error' && result.uncertainty
    ? '\n\nResponse confirmation: uncertain' : '';
  const setupNote = result.outcomeLabelsIncomplete
    ? '\n\nOutcome-label setup is incomplete. Create missing review outcome labels manually in repository settings.' : '';
  try {
    const handle = await open(filename, 'a');
    try { await handle.writeFile(`## Mellon moderation\n\n${labels[result.outcome]}${score}${labelNote}${partial}${uncertainty}${setupNote}\n`, 'utf8'); }
    finally { await handle.close(); }
  } catch {
    // Summaries are optional and contain no event text or credentials.
  }
}

export async function main() {
  const result = await runAction({
    getuid: process.getuid?.bind(process),
    getInput: name => process.env[`INPUT_${name.toUpperCase()}`] ?? '',
  });
  if (result.outcome === 'error') process.exitCode = 1;
  return result;
}
