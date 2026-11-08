import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { validateCoordinatorConfig } from './approval.mjs';
import { validateChanges } from './patch.mjs';
import { buildCoordinatorPhaseKey, validateCoordinatorPhase, validateIntent } from './store-validation.mjs';
import { buildOperationHash, gitBlobSha, snapshotPublicationRequest } from './publication-validation.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PURPOSES = new Set(['initial_tests', 'initial_implementation', 'repair_tests', 'repair_implementation']);
const fail = () => { throw new TypeError('Candidate validation rejected.'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function validateCallbackContext(callback) {
  if (callback.params.some(parameter => parameter.type !== 'Identifier')) fail();
  const contextName = callback.params[0]?.name;
  function walk(node, parent, field) {
    if (!node || typeof node !== 'object') return;
    const propertyName = parent?.type === 'MemberExpression' && field === 'property' && !parent.computed
      || parent?.type === 'Property' && field === 'key' && !parent.computed && !parent.shorthand;
    if (node.type === 'Identifier' && node.name === 'arguments' && !propertyName) fail();
    if (node.type === 'MemberExpression' && !node.computed
      && ['arguments', 'caller', 'callee'].includes(node.property.name)) fail();
    const contextReference = node.type === 'ThisExpression'
      || node.type === 'Identifier' && node.name === contextName && !propertyName;
    if (contextReference && (parent?.type !== 'MemberExpression' || field !== 'object'
      || parent.computed || parent.optional || parent.property.type !== 'Identifier'
      || ['skip', 'todo', 'test', 'runOnly'].includes(parent.property.name))) fail();
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(child)) child.forEach(value => walk(value, node, key));
      else if (child && typeof child === 'object') walk(child, node, key);
    }
  }
  walk(callback.body, callback, 'body');
}

function selectedIdentity(source, path, name) {
  const ast = parse(source, { ecmaVersion: 2024, sourceType: 'module', locations: true, preserveParens: true });
  let binding;
  const permittedReferences = new Set();
  const calls = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.source.value === 'node:test') {
        if (binding || node.specifiers.length !== 1) fail();
        const specifier = node.specifiers[0];
        if (specifier.local.name !== 'test' || !(specifier.type === 'ImportDefaultSpecifier'
          || specifier.type === 'ImportSpecifier' && specifier.imported.name === 'test')) fail();
        binding = specifier.local;
        permittedReferences.add(specifier.local);
        if (specifier.imported) permittedReferences.add(specifier.imported);
      } else if (node.specifiers.some(specifier => specifier.local.name === 'test')) fail();
      continue;
    }
    if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression') fail();
    const call = node.expression;
    if (call.optional || call.callee.type !== 'Identifier' || call.callee.name !== 'test'
      || call.arguments.length !== 2 || call.arguments[0].type !== 'Literal'
      || typeof call.arguments[0].value !== 'string'
      || !['ArrowFunctionExpression', 'FunctionExpression'].includes(call.arguments[1].type)
      || call.arguments[1].body.type !== 'BlockStatement' || call.arguments[1].generator) fail();
    validateCallbackContext(call.arguments[1]);
    permittedReferences.add(call.callee);
    calls.push(call);
  }
  if (!binding) fail();
  // No alias, shadow, generated registration, namespace, or nested use of the binding.
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && node.name === 'test' && !permittedReferences.has(node)) fail();
    if (node.type === 'ImportExpression' || node.type === 'Identifier'
      && ['eval', 'Function', 'require'].includes(node.name)) fail();
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  }
  walk(ast);
  const selected = calls.filter(call => call.arguments[0].value === name);
  if (selected.length !== 1 || new Set(calls.map(call => call.arguments[0].value)).size !== calls.length) fail();
  const call = selected[0];
  const identity = { column: call.loc.start.column + 1, entryFile: path, line: call.loc.start.line, name, nesting: 0, type: 'test' };
  return hash(canonical(identity));
}
function validatedFiles(files, allowedPaths) {
  if (!Array.isArray(files) || files.length > 128 || !Array.isArray(allowedPaths)) fail();
  const allowed = new Set(allowedPaths);
  const ancestors = new Set();
  for (const path of allowedPaths) {
    if (typeof path !== 'string') fail();
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) ancestors.add(parts.slice(0, index).join('/'));
  }
  const prepared = new Map();
  let bytes = 0;
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || prepared.has(file.path)
      || !allowed.has(file.path) && !ancestors.has(file.path)) fail();
    prepared.set(file.path, file);
    if (file.mode === null || file.mode === '040000') {
      if (!exact(file, ['path', 'mode', 'blobSha']) || file.blobSha !== null
        || file.mode === '040000' && !ancestors.has(file.path)) fail();
    } else {
      if (!exact(file, ['path', 'mode', 'blobSha', 'text', 'sha256'])
        || !allowed.has(file.path) || file.mode !== '100644'
        || typeof file.blobSha !== 'string' || !SHA1.test(file.blobSha)
        || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)
        || typeof file.text !== 'string' || Buffer.byteLength(file.text) > 65536
        || Buffer.from(file.text).toString('utf8') !== file.text
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(file.text)
        || gitBlobSha(file.text) !== file.blobSha || hash(file.text) !== file.sha256) fail();
      bytes += Buffer.byteLength(file.text);
      if (bytes > 262144) fail();
    }
  }
  for (const path of allowed) if (!prepared.has(path)) fail();
  for (const path of ancestors) {
    const ancestor = prepared.get(path);
    if (!ancestor || ![null, '040000'].includes(ancestor.mode)) fail();
  }
  for (const file of files) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (prepared.get(parts.slice(0, index).join('/'))?.mode === null && file.mode !== null) fail();
    }
  }
  // Preserve prepared-array indexing for assessment references.
  return files.map(({ path, mode, blobSha }) => ({ path, mode, blobSha }));
}
function validAssessment(assessment, phase, manifest, files, investigation) {
  if (!exact(investigation, ['version', 'findingSha256', 'headSha', 'criteria', 'references', 'regressionFileIndex'])
    || investigation.version !== 1 || investigation.headSha !== phase.headSha
    || investigation.findingSha256 !== phase.findingSha256
    || !Array.isArray(investigation.criteria) || !investigation.criteria.length || investigation.criteria.length > 32
    || !Array.isArray(investigation.references) || !investigation.references.length || investigation.references.length > 16
    || !Number.isSafeInteger(investigation.regressionFileIndex) || investigation.regressionFileIndex < 0
    || investigation.regressionFileIndex >= files.length
    || new Set(investigation.criteria.map(criterion => criterion.criterionIndex)).size !== investigation.criteria.length
    || investigation.criteria.some(criterion => !exact(criterion, ['criterionIndex', 'criterionSha256'])
      || !Number.isSafeInteger(criterion.criterionIndex) || criterion.criterionIndex < 0
      || criterion.criterionIndex >= manifest.acceptanceCriteria.length
      || criterion.criterionSha256 !== hash(manifest.acceptanceCriteria[criterion.criterionIndex]))
    || new Set(investigation.references.map(canonical)).size !== investigation.references.length
    || investigation.references.some(reference => !exact(reference, ['fileIndex', 'blobSha', 'testIdentitySha256'])
      || !Number.isSafeInteger(reference.fileIndex) || reference.fileIndex < 0 || reference.fileIndex >= files.length
      || !manifest.allowedPaths.includes(files[reference.fileIndex].path)
      || files[reference.fileIndex].mode !== '100644' || files[reference.fileIndex].blobSha !== reference.blobSha
      || reference.testIdentitySha256 !== null && !SHA256.test(reference.testIdentitySha256 ?? ''))
    || files[investigation.regressionFileIndex]?.path !== manifest.allowedPaths[manifest.coordinator.regression.testPathIndex]
    || !exact(assessment, ['disposition', 'findingSha256', 'criterionIndex', 'criterionSha256', 'references'])
    || assessment.disposition !== 'confirmed' || !SHA256.test(phase.findingSha256 ?? '')
    || assessment.findingSha256 !== phase.findingSha256
    || !Number.isSafeInteger(assessment.criterionIndex) || assessment.criterionIndex < 0
    || assessment.criterionIndex >= manifest.acceptanceCriteria.length
    || assessment.criterionSha256 !== hash(manifest.acceptanceCriteria[assessment.criterionIndex])
    || !investigation.criteria.some(criterion => exact(criterion, ['criterionIndex', 'criterionSha256'])
      && criterion.criterionIndex === assessment.criterionIndex && criterion.criterionSha256 === assessment.criterionSha256)
    || !Array.isArray(assessment.references) || !assessment.references.length || assessment.references.length > 16) fail();
  const seen = new Set();
  for (const reference of assessment.references) {
    const keys = ['fileIndex', 'blobSha', 'testIdentitySha256'];
    const referenceKey = canonical(reference);
    if (!exact(reference, keys) || !Number.isSafeInteger(reference.fileIndex) || reference.fileIndex < 0
      || reference.fileIndex >= files.length || seen.has(referenceKey)
      || !investigation.references.some(approved => exact(approved, keys) && canonical(approved) === referenceKey)
      || reference.testIdentitySha256 !== null && !SHA256.test(reference.testIdentitySha256 ?? '')) fail();
    seen.add(referenceKey);
    const file = files[reference.fileIndex];
    if (!manifest.allowedPaths.includes(file.path) || file.mode !== '100644' || file.blobSha !== reference.blobSha) fail();
  }
  return assessment.criterionIndex;
}

/** Parse and bind a transient proposal to the pinned selection and publisher contract. */
export function prepareCandidate(input) {
  try {
    const { publicationRun, approvedManifest: manifest, modelOperationId, changes, baseFiles, assessment } = input;
    const { investigation, startedAt, waitStartedAt, pendingOperationId, ...phaseValue } = input.phase;
    for (const timestamp of [startedAt, waitStartedAt]) {
      if (timestamp !== undefined && timestamp !== null
        && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) fail();
    }
    if (pendingOperationId !== undefined && pendingOperationId !== null) fail();
    const phase = validateCoordinatorPhase(phaseValue);
    if (!manifest?.coordinator || !validateCoordinatorConfig(manifest) || !UUID.test(modelOperationId ?? '')
      || !phase || !PURPOSES.has(phase.purpose) || phase.headSha !== publicationRun.expectedHeadSha
      || !Number.isSafeInteger(phase.repairCycle) || phase.repairCycle < 0 || phase.repairCycle > 2
      || phase.purpose.startsWith('initial_') && (phase.repairCycle !== 0 || phase.findingSha256 !== null)
      || phase.purpose.startsWith('repair_') && (phase.repairCycle < 1 || !SHA256.test(phase.findingSha256 ?? ''))) fail();
    const config = manifest.coordinator.regression;
    const path = manifest.allowedPaths[config.testPathIndex];
    const testing = phase.purpose.endsWith('_tests');
    const name = phase.repairCycle === 0 ? config.initial.testName : config.repairTestNames[phase.repairCycle - 1];
    let criterionIndex = config.initial.criterionIndex;
    const metadataFiles = validatedFiles(baseFiles, manifest.allowedPaths);
    if (phase.purpose === 'repair_tests') criterionIndex = validAssessment(assessment, phase, manifest, baseFiles, investigation);
    else if (assessment !== undefined) fail();
    const accepted = validateChanges(metadataFiles, changes, { allowedPaths: manifest.allowedPaths, pilotScope: manifest.pilotScope });
    if (accepted.some(change => change.mode !== '100644')) fail();
    let testIdentitySha256, expectedRegression;
    if (testing) {
      if (accepted.length !== 1 || accepted[0].path !== path) fail();
      testIdentitySha256 = selectedIdentity(accepted[0].content, path, name);
    } else {
      if (accepted.some(change => change.path === path)) fail();
      const file = baseFiles.find(file => file.path === path);
      if (typeof file?.text !== 'string' || file.mode !== '100644') fail();
      testIdentitySha256 = selectedIdentity(file.text, path, name);
      expectedRegression = phase.expectedRegression;
      if (!exact(expectedRegression, ['workflowId', 'testIdentitySha256', 'proposalSha256'])
        || expectedRegression.workflowId !== config.workflowId || expectedRegression.testIdentitySha256 !== testIdentitySha256
        || !SHA256.test(expectedRegression.proposalSha256 ?? '')) fail();
      if (phase.purpose === 'repair_implementation') {
        criterionIndex = manifest.acceptanceCriteria.findIndex(criterion => hash(criterion) === phase.criterionSha256);
        if (criterionIndex < 0) fail();
      }
    }
    const phaseKey = buildCoordinatorPhaseKey({ runId: publicationRun.id, manifestSha256: publicationRun.manifestSha256,
      purpose: phase.purpose, repairCycle: phase.repairCycle, headSha: phase.headSha, findingSha256: phase.findingSha256 });
    if (phase.key !== phaseKey || phase.criterionSha256 != null
      && phase.criterionSha256 !== hash(manifest.acceptanceCriteria[criterionIndex])) fail();
    const probe = snapshotPublicationRequest({ run: publicationRun, intent: { id: phaseKey }, approvedManifest: manifest, proposedChanges: changes });
    const operationHash = buildOperationHash(probe, accepted);
    const key = hash(canonical({ version: 1, phaseKey, modelOperationId, operationHash }));
    const publication = snapshotPublicationRequest({ ...probe, intent: { id: key } });
    if (testing) expectedRegression = { workflowId: config.workflowId, testIdentitySha256, proposalSha256: operationHash };
    const descriptors = accepted.map(change => ({
      approvedPathIndex: manifest.allowedPaths.indexOf(change.path), operation: change.operation,
      beforeBlobSha: change.expectedBlobSha, afterBlobSha: change.contentBlobSha,
      contentSha256: hash(change.content), bytes: change.contentBytes, mode: '100644',
    }));
    const metadata = { version: 1, purpose: phase.purpose, phaseKey, repairCycle: phase.repairCycle,
      modelOperationId, expectedRegression, criterionSha256: hash(manifest.acceptanceCriteria[criterionIndex]),
      candidateDescriptors: descriptors };
    const intent = validateIntent({ key, kind: 'commit_create', inputHash: operationHash,
      expectedHeadSha: publicationRun.expectedHeadSha, coordinator: metadata });
    return freeze({ publication, changes: accepted, intent, metadata, expectedRegression });
  } catch { fail(); }
}
