import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed Node 24 DB-guard identities; provenance is in docs/agent-worker-ci.md.
export const DATABASE_SKIP_IDENTITIES = Object.freeze([
  '054c8cebc9f59c0f5b3df8645b83269d4869f288e4773579ff095bfcc8711916',
  '06f53c57b7875ac7d27e507ab59de75f4601209dc58983b10f69036d4f0ad911',
  '073893e4b507150916036e54c92851b867d7d33a73fcb4a67cb9fdb4a9ec21c9',
  '09d72ef105de01bfaf403c942a714a28bc82bc304e57019e8af60c22cfb29c0e',
  '0b9361c3727b0ef8d53bbff3030fd9ba2a100e161c0c256723eccba14cf749b0',
  '0fad7c720bf4c1fafa0c38d76669ed51f38f7c664ac1b3dccdd7ed421d4f8306',
  '163fa9b39f0587f0d3af8cf3210a4268f3eee4a9aad0a7199084a52e626826f3',
  '1683107fd49d173374111c3af2778cde6c7c08736c2fe64aa5785aac69d4975f',
  '194abf4587f35bbf8c037012ed12c1eaf3dd0ef55d1cf5fada8b4263c094bbe3',
  '1f54d40a00c740e78458e9c95883bbd96937fa9fa4ff51daa380a8ff30f95adc',
  '2b0b8715261ad60afd4709a279b8d4f2d3a9a2ef201c4dea970b4f9fbf61621b',
  '2baa5705bbc72d527fc1607d0d64d8173432cae8b34a6dfb13a62fc5a4dd3eda',
  '2cbad49675c7efd17571f47dda52105b53308c984a839bce01557acb4f89223f',
  '2e23a4afccc05cfaa0de683285bfea57b2424e8f9ab9147b5c1942a8c392c012',
  '38bfb735bd76915a81a33ad9c4be6114cb8c6a69b587057ad2705d9ec85676d5',
  '392e42a4eb60f95fdb429cb23b34a549f903b1482887948d6cdb7ac318b1ede7',
  '3aa113afae75d8a35ff9e73a050439891f263604112cc7cee95c6e24ce96dd17',
  '47b077b2c0dd42055a5762137f5a7f223e6d3eb29a6dfb97798547c61f41a5f7',
  '4ec67740b10db940f9cb6b68944140680007291734e667dcba496b8b646dacc8',
  '522d920ab082dae3e5d02f096ba97b00aac86a9621bbe81dcbc333dbb9a86b4f',
  '536a7f5a95a1f09ab1ad213eeaf4ec002229b33d95511d97a48740a53b7874ec',
  '5689f6b7ce57eed41fa99126c0ba14a839d3b22b7eb11e2295cf5159bb7a933e',
  '5ca8158c655bb17c3273e0f116593a9d658d928b9d651ba12e654bd36d7e9d52',
  '6943c432a17e2dfd6b47f398926bd05bba64d3347dfe666be90fcd57ad205282',
  '7a0b5d45ba181d03eabf7b6859d6cdf0b284f5a3fd868cb99072673fcd41060b',
  '819f41c8a33f9af1bf78efc211a6caace85ca3c72ba9d528616b3cd66407c771',
  '88f5e2edb2cd224859f784fd4a7e3216619192d554fa77de163128b620c7fa8a',
  '892861a24581f413392210e5a83aa0b3358edcfeeabb984335f42621dd408400',
  '8a08bf1f3962c2a50dd0bcb885f2bc9c30c9c00db43a6b8c790fc1e96a456792',
  '8e5f94441fa70f8f8e1e8e670edd98d0fdd18225b4a6b60173fb8401ef5705a8',
  '96978d049fe6694893ed9b2fd4837fb3ccb59fac92705440a76b7c6255140f05',
  '96d460ace5da371943ba558997cf752a74ae70866aa64f3a7febe767f543a19d',
  '9b01be3a8bd040167f95b1454cf9f956a3bdcf0f32deef9b062c4d16e0d2fd84',
  '9e669c1aad933f44c2c856867d37d15e6d6f2191f678944a9bf66b11536ccb9f',
  'a92115413c22249f2459ba60a22daf84273945d96b30aa4d26b7f0102e94f40d',
  'b0aaf0ddd3b557c44782ff485a1e836430e404a1c62d5183e603ab37c591093b',
  'b3a8ae769e55b89259d4a23cc495d8cfde6900b1f75496ac3238dd4e73f60edd',
  'b99e8f48d78366cdc488e2ac8e4dfa560a846182e21664968d669b7d34b34c28',
  'bb3582afe4d546be92e5fbb14a32c64ab4d2d56ed1876e11f75ae8f120b9c577',
  'bcdda4a74dfbe9cec3c179e706840854c8e30f33759709d793f5b59339ce6b00',
  'bfbf71945ff40f5807727d3e9aa009e1ba5f8763db15e74f8b6e9d115bce89e9',
  'ca6e548eee2c834dc6406da98fe02623a7f6503bbab9058b52fd07295e236da1',
  'd1c1e205b8e1c52fecda36df90cf4bf3d8a51257f65bc647e6be13fe53c46f0b',
  'd4c2612bcd51bfcdc0a906197be9247dc6d08b5b58087d0788d25e78f0f1fa05',
  'd50be9b0b1afcdff68c30009b314428422d59ed3037e6db457c94a8bf962af97',
  'd62fca6fcda07658e44eb3ae4ac26d731deb7e6a0f02c5e1a7abda74fc9d3a17',
  'd6b6542401f6d304e187b41d8d3fda7ca2a400ff2849318087479907342b2fb1',
  'd79eb01949f75ac5d93ecd2b83bf1bc548d1ddd0763b2a528af62211cd4aae8d',
  'd8454531b1b70f0746af68a8b210ccf0a8f24c5915a9694a4c8b650c096c197d',
  'dbc78016e62839718446d0279b1f444e51bcc304dc77b65492fad6a6c863d97d',
  'de02bcac3413af36f31b898cb4b37fa479053ed0cabe5b9ce8e760fb219ffcf0',
  'dfdfcec66e375d68afaf56ac7c69c8ecae3ba1c7f3fef5026d0bae93a5bff5c2',
  'e1506f889542ae0ce4948e9fd2014ceb021e6f2fea8dfccb80903d7008988c02',
  'e2832ccade822e9d01920deae34ef633d2f7940cd63fdaf0705470b6e3d66299',
  'e9a1ad85b678bfeb22a68ba195f1c93e2e7d5cd16bde070d85bcb5724169c244',
  'eaac2a86ba645efa1788da064367a2b73c84e08312e4156756bd3e1ba7f3c90d',
  'ed5d204b0eadbb7c629110a62d52f6789497376b3a76ec80edf827211fe625dd',
  'f0b06beee82fe7361694cebdd880eb2826e3ab6833f90fc7a1d5a83aa249517c',
  'f0d17beef5057213db8a5f71bbf6e574628056be8f4a87f5b8b56ee6a7a6801a',
  'f0d3fd69420d0be6d7e9b5ada2fabb5c42ac57553fef5e2e6cc11b231f33eee6',
  'f3fa47ae507f179e29f7da1499ecc50f96bbc9eeea8e6b089359baee22a428fb',
  'f78af322925bbc9076f0ad31a27a6f59234cd20849ce349df178cfa9d7a05557',
]);
export const DATABASE_SKIP_POLICY_SHA256 = 'bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab';

const MAX_REPORT_BYTES = 24 * 1024;
const MAX_ENCODED_REPORT_BYTES = 32 * 1024;
const MAX_ANNOTATION_BYTES = 32 * 1024;
const CHUNK_DATA_LENGTH = 3500;
const MAX_CHUNKS = 10;
const CHUNK_PREFIX = 'MELLON_CI_REPORT_V2_CHUNK:';
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REPORT_PREFIX = 'MELLON_CI_RAW_V2:';
const COUNT_KEYS = [
  'testCount', 'passedTestCount', 'failedTestCount', 'aggregateFailureCount',
  'assertionFailureCount', 'setupFailureCount', 'syntaxFailureCount', 'otherFailureCount',
  'skippedTestCount', 'todoTestCount', 'cancelledTestCount', 'rootFailureCount',
];
const FAILURE_CATEGORIES = new Set(['assertion', 'other', 'setup', 'syntax']);

function sameKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function validContext(context, environment) {
  return sameKeys(context, ['repository', 'headSha', 'runId', 'runAttempt'])
    && context.repository === environment.GITHUB_REPOSITORY
    && context.headSha === environment.GITHUB_SHA
    && context.runId === environment.GITHUB_RUN_ID
    && Number.isSafeInteger(context.runAttempt)
    && String(context.runAttempt) === environment.GITHUB_RUN_ATTEMPT;
}

function validReport(report, environment) {
  const reportKeys = [
    'schemaVersion', 'complete', 'truncated', 'reason', 'context', 'producerSha256',
    'counts', 'failures', 'rootFailures', 'skipPolicySha256', 'skippedTestIdentitySha256s',
  ];
  if (!sameKeys(report, reportKeys) || report.schemaVersion !== 2
      || typeof report.complete !== 'boolean' || typeof report.truncated !== 'boolean'
      || !validContext(report.context, environment)
      || typeof report.producerSha256 !== 'string' || !SHA256.test(report.producerSha256)
      || !sameKeys(report.counts, COUNT_KEYS)
      || !COUNT_KEYS.every(key => Number.isSafeInteger(report.counts[key])
        && report.counts[key] >= 0 && report.counts[key] <= 20000)
      || !Array.isArray(report.failures) || report.failures.length > 64
      || !report.failures.every(item => sameKeys(item, ['testIdentitySha256', 'category'])
        && typeof item.testIdentitySha256 === 'string' && SHA256.test(item.testIdentitySha256)
        && FAILURE_CATEGORIES.has(item.category))
      || report.skipPolicySha256 !== DATABASE_SKIP_POLICY_SHA256
      || createHash('sha256').update(JSON.stringify({
        testIdentitySha256s: DATABASE_SKIP_IDENTITIES, version: 1,
      })).digest('hex') !== DATABASE_SKIP_POLICY_SHA256
      || !Array.isArray(report.skippedTestIdentitySha256s)
      || report.skippedTestIdentitySha256s.length > DATABASE_SKIP_IDENTITIES.length
      || !report.skippedTestIdentitySha256s.every(id => typeof id === 'string'
        && SHA256.test(id) && DATABASE_SKIP_IDENTITIES.includes(id))
      || new Set(report.skippedTestIdentitySha256s).size !== report.skippedTestIdentitySha256s.length
      || report.counts.skippedTestCount !== report.skippedTestIdentitySha256s.length
      || new Set(report.failures.map(item => item.testIdentitySha256)).size !== report.failures.length
      || report.failures.some(item => report.skippedTestIdentitySha256s.includes(item.testIdentitySha256))
      || report.counts.todoTestCount !== 0 || report.counts.cancelledTestCount !== 0
      || !Array.isArray(report.rootFailures) || report.rootFailures.length > 64
      || !report.rootFailures.every(item => sameKeys(item, ['category'])
        && FAILURE_CATEGORIES.has(item.category))) return false;
  const counts = report.counts;
  const categories = { assertion: 0, other: 0, setup: 0, syntax: 0 };
  for (const item of [...report.failures, ...report.rootFailures]) categories[item.category] += 1;
  if (counts.failedTestCount !== report.failures.length
      || counts.rootFailureCount !== report.rootFailures.length
      || counts.testCount !== counts.passedTestCount + counts.failedTestCount
        + counts.aggregateFailureCount + counts.skippedTestCount + counts.todoTestCount + counts.cancelledTestCount
      || Object.entries(categories).some(([category, count]) => counts[`${category}FailureCount`] !== count)) return false;
  return report.complete && report.truncated === false && report.reason === null
    && (counts.testCount > 0 || counts.rootFailureCount > 0);
}

export function buildTrustedAnnotation(environment) {
  const encoded = environment.MELLON_CI_ENCODED_REPORT;
  const exitText = environment.MELLON_CI_TEST_EXIT_CODE;
  if (typeof encoded !== 'string' || encoded.length === 0
      || encoded.length > MAX_ENCODED_REPORT_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)
      || typeof exitText !== 'string' || !/^(?:0|[1-9][0-9]{0,2})$/.test(exitText)
      || !REPOSITORY.test(environment.GITHUB_REPOSITORY ?? '')
      || !SHA.test(environment.GITHUB_SHA ?? '')
      || !/^[1-9][0-9]{0,15}$/.test(environment.GITHUB_RUN_ID ?? '')
      || !/^[1-9][0-9]{0,3}$/.test(environment.GITHUB_RUN_ATTEMPT ?? '')
      || Number(environment.GITHUB_RUN_ATTEMPT) > 1000
      || !SHA.test(environment.MELLON_CI_REPORTER_REVISION ?? '')) return null;
  let report;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length > MAX_REPORT_BYTES || bytes.toString('base64url') !== encoded) return null;
    report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const exitCode = Number(exitText);
  const hasFailures = report?.counts && (
    report.counts.failedTestCount > 0 || report.counts.aggregateFailureCount > 0
      || report.counts.rootFailureCount > 0 || report.counts.cancelledTestCount > 0
      || report.counts.setupFailureCount > 0 || report.counts.syntaxFailureCount > 0
      || report.counts.otherFailureCount > 0);
  if (exitCode > 255 || !validReport(report, environment)
      || !report.complete && exitCode === 0 || report.complete && exitCode === 0 && hasFailures) return null;
  const payload = Buffer.from(JSON.stringify({
    ...report,
    processExitCode: exitCode,
    formatterRevision: environment.MELLON_CI_REPORTER_REVISION,
  }), 'utf8').toString('base64url');
  const legacy = `::notice::MELLON_CI_REPORT_V2:${payload}`;
  if (Buffer.byteLength(legacy, 'utf8') > MAX_ANNOTATION_BYTES) return null;
  if (payload.length <= CHUNK_DATA_LENGTH) return legacy;
  const count = Math.ceil(payload.length / CHUNK_DATA_LENGTH);
  if (count > MAX_CHUNKS) return null;
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  // GitHub's annotation API clips long messages; each transport part stays below 4 KiB.
  return Array.from({ length: count }, (_, index) =>
    `::notice::${CHUNK_PREFIX}${digest}:${index + 1}:${count}:${payload.slice(index * CHUNK_DATA_LENGTH, (index + 1) * CHUNK_DATA_LENGTH)}`
  ).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let checkedOutRevision;
  try {
    checkedOutRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    checkedOutRevision = '';
  }
  const annotation = checkedOutRevision === process.env.MELLON_CI_REPORTER_REVISION
    ? buildTrustedAnnotation(process.env)
    : null;
  if (!annotation) {
    process.stderr.write('Trusted CI report rejected.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${annotation}\n`);
  }
}
