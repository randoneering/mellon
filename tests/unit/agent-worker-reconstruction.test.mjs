import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCandidate } from '../../src/automation/worker/candidate.mjs';
import { createRepositoryReader } from '../../src/automation/worker/repository.mjs';
import { candidateInput, phaseFor, blob, HEAD, PATH, SOURCE, RUN_ID, repositoryConfig } from '../fixtures/worker-candidates/inputs.mjs';
const ROOT = '/repos/randoneering/mellon';
const CANDIDATE = 'e'.repeat(40), BEFORE_TREE = '1'.repeat(40), AFTER_TREE = '2'.repeat(40);
const ACTOR = { databaseId: 777, login: 'worker[bot]' };
function scenario(mutate = (key, value) => value, parentHead = HEAD) {
  const input = candidateInput();
  input.publicationRun.expectedHeadSha = parentHead; input.phase = phaseFor(input.publicationRun);
  const result = prepareCandidate(input);
  const publication = structuredClone({ run: result.publication.run, intent: result.publication.intent, approvedManifest: result.publication.approvedManifest });
  const branch = `agent-work/${RUN_ID}`;
  const tree = [
    { path: 'tests', mode: '040000', type: 'tree', sha: '3'.repeat(40) },
    { path: 'tests/fixtures', mode: '040000', type: 'tree', sha: '4'.repeat(40) },
    { path: 'tests/fixtures/worker-candidates', mode: '040000', type: 'tree', sha: '5'.repeat(40) },
    { path: PATH, mode: '100644', type: 'blob', sha: blob(SOURCE) },
  ];
  const routes = {
    [ROOT]: { id: 123456, full_name: 'randoneering/mellon', private: false },
    [`${ROOT}/git/ref/heads/${branch}`]: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: CANDIDATE } },
    [`${ROOT}/git/commits/${parentHead}`]: { sha: parentHead, tree: { sha: BEFORE_TREE }, parents: parentHead === HEAD ? [] : [{ sha: HEAD }] },
    [`${ROOT}/git/commits/${CANDIDATE}`]: { sha: CANDIDATE, tree: { sha: AFTER_TREE }, parents: [{ sha: parentHead }] },
    [`${ROOT}/git/trees/${BEFORE_TREE}?recursive=1`]: { sha: BEFORE_TREE, truncated: false, tree: [] },
    [`${ROOT}/git/trees/${AFTER_TREE}?recursive=1`]: { sha: AFTER_TREE, truncated: false, tree },
    [`${ROOT}/git/blobs/${blob(SOURCE)}`]: { sha: blob(SOURCE), size: Buffer.byteLength(SOURCE), encoding: 'base64', content: Buffer.from(SOURCE).toString('base64') },
    '/graphql': { data: { repository: {
      databaseId: 123456, nameWithOwner: 'randoneering/mellon',
      object: { oid: CANDIDATE, tree: { oid: AFTER_TREE }, parents: { nodes: [{ oid: parentHead }] }, author: { user: ACTOR }, committer: { user: ACTOR }, signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } },
      ref: { prefix: 'refs/heads/', name: branch, target: { oid: CANDIDATE } },
    } } },
  };
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url), key = parsed.pathname + parsed.search;
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    let oid;
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      oid = body.variables.oid;
      assert.ok(body.query.startsWith('query AgentWorkerCommitProof'));
      assert.ok([CANDIDATE, parentHead].includes(oid));
      assert.deepEqual(body.variables, { owner: 'randoneering', name: 'mellon', oid, qualifiedRefName: `refs/heads/${branch}` });
    } else assert.equal(options.method, 'GET');
    calls.push(key);
    let route = structuredClone(routes[key]);
    if (key === '/graphql' && oid === parentHead) {
      route.data.repository.object.oid = parentHead;
      route.data.repository.object.tree.oid = BEFORE_TREE;
      route.data.repository.object.parents.nodes = [{ oid: HEAD }];
    }
    const value = mutate(key, route, oid);
    assert.notEqual(value, undefined, key);
    return new Response(JSON.stringify(value));
  };
  return { reader: createRepositoryReader({ ...repositoryConfig({ fetch }), ownedActor: ACTOR }), publication, metadata: structuredClone(result.metadata), calls };
}
const read = state => state.reader.reconstructCandidate({ publication: state.publication, metadata: state.metadata, deadline: Date.now() + 1000 });

test('reconstruction returns only an observed owned descriptor-exact original publication', async () => {
  const state = scenario(); const reconstructed = await read(state);
  assert.equal(reconstructed.observedHeadSha, CANDIDATE);
  assert.equal(reconstructed.operationHash, prepareCandidate(candidateInput()).intent.inputHash);
  assert.equal(reconstructed.publication.proposedChanges[0].content, SOURCE);
  assert.deepEqual(reconstructed.intent, prepareCandidate(candidateInput()).intent);
});
test('reconstruction verifies an owned immutable expected parent before rebuilding content', async () => {
  const parent = 'd'.repeat(40);
  const result = await read(scenario(undefined, parent));
  assert.equal(result.publication.run.expectedHeadSha, parent);
  assert.equal(result.observedHeadSha, CANDIDATE);
});

test('reconstruction rejects a foreign expected parent despite an owned candidate', async () => {
  const parent = 'd'.repeat(40);
  await assert.rejects(read(scenario((key, value, oid) => {
    if (key === '/graphql' && oid === parent) value.data.repository.object.author.user.databaseId = 1;
    return value;
  }, parent)), /Repository/);
});

test('reconstruction rejects parent proof and immutable parent tree disagreement', async () => {
  const parent = 'd'.repeat(40);
  await assert.rejects(read(scenario((key, value, oid) => {
    if (key === '/graphql' && oid === parent) value.data.repository.object.tree.oid = 'f'.repeat(40);
    return value;
  }, parent)), /Repository/);
});

for (const [name, mutate] of Object.entries({
  'no observed candidate': (key, value) => key.includes('/git/ref/') ? { ...value, object: { type: 'commit', sha: HEAD } } : value,
  'foreign actor': (key, value) => { if (key === '/graphql') value.data.repository.object.author.user.databaseId = 1; return value; },
  'invalid signature': (key, value) => { if (key === '/graphql') value.data.repository.object.signature.isValid = false; return value; },
  'wrong parent proof': (key, value) => { if (key === '/graphql') value.data.repository.object.parents.nodes[0].oid = 'f'.repeat(40); return value; },
  'proof tree mismatch': (key, value) => { if (key === '/graphql') value.data.repository.object.tree.oid = 'f'.repeat(40); return value; },
  'REST candidate parent mismatch': (key, value) => key === `${ROOT}/git/commits/${CANDIDATE}` ? { ...value, parents: [{ sha: 'f'.repeat(40) }] } : value,
  'stale proof head': (key, value) => { if (key === '/graphql') value.data.repository.ref.target.oid = 'f'.repeat(40); return value; },
  'extra unapproved file': (key, value) => { if (key.includes(`/trees/${AFTER_TREE}`)) value.tree.push({ path: 'unapproved.mjs', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }); return value; },
  'extra changed mode': (key, value) => { if (key.includes(`/trees/${AFTER_TREE}`)) value.tree.at(-1).mode = '100755'; return value; },
  'missing descriptor path': (key, value) => { if (key.includes(`/trees/${AFTER_TREE}`)) value.tree.pop(); return value; },
})) test(`reconstruction rejects ${name}`, async () => { await assert.rejects(read(scenario(mutate)), /Repository/); });
for (const [name, mutate] of Object.entries({
  'wrong original operation key': s => { s.publication.intent.id = 'f'.repeat(64); },
  'forged descriptor hash': s => { s.metadata.candidateDescriptors[0].contentSha256 = 'f'.repeat(64); },
  'forged descriptor index': s => { s.metadata.candidateDescriptors[0].approvedPathIndex = 1; },
  'duplicate descriptor index': s => { s.metadata.candidateDescriptors.push({ ...s.metadata.candidateDescriptors[0] }); },
  'forged descriptor size': s => { s.metadata.candidateDescriptors[0].bytes = 1; },
  'noncanonical descriptor mode': s => { s.metadata.candidateDescriptors[0].mode = '100755'; },
  'excess descriptors': s => { s.metadata.candidateDescriptors = Array.from({ length: 11 }, () => s.metadata.candidateDescriptors[0]); },
})) test(`reconstruction rejects ${name}`, async () => { const state = scenario(); mutate(state); await assert.rejects(read(state), /Repository/); });
