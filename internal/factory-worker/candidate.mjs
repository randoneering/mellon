import { createHash } from 'node:crypto';
import { NO_REBUILD_PATH, REBUILD_PATH } from './control-policy.mjs';

const ERROR = 'Factory candidate rejected.';
const SECRET = /-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
function reject() { throw new Error(ERROR); }
function checkedScope(config) {
  if (!/^[a-f0-9]{40}$/.test(config?.baseSha ?? '') || !Array.isArray(config.allowedPaths)
      || !config.allowedPaths.length || config.allowedPaths.length > 10
      || new Set(config.allowedPaths).size !== config.allowedPaths.length) reject();
  for (const path of config.allowedPaths) {
    if (typeof path !== 'string' || path.split('/').some(p => !p || p === '.' || p === '..')
        // One policy for jobs and exports, so an accepted job never fails at export.
        || !(NO_REBUILD_PATH.test(path) || REBUILD_PATH.test(path))) reject();
  }
}

export function validateCandidate(value, config) {
  checkedScope(config);
  if (!value || value.baseSha !== config.baseSha || !Array.isArray(value.files)
      || !value.files.length || value.files.length > config.allowedPaths.length) reject();
  const seen = new Set();
  let totalBytes = 0;
  const files = value.files.map(file => {
    if (!file || !config.allowedPaths.includes(file.path) || seen.has(file.path)) reject();
    seen.add(file.path);
    // A planned deletion carries no content; anything else must be complete text.
    if (file.deleted !== undefined) {
      if (file.deleted !== true || file.content !== undefined) reject();
      return { path: file.path, deleted: true };
    }
    if (typeof file.content !== 'string' || !file.content.length || file.content.includes('\0')
        || SECRET.test(file.content)) reject();
    totalBytes += Buffer.byteLength(file.content, 'utf8');
    if (totalBytes > 128 * 1024) reject();
    return { path: file.path, content: file.content, sha256: createHash('sha256').update(file.content).digest('hex') };
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash('sha256').update(JSON.stringify({ baseSha: config.baseSha, files: files.map(f => (f.deleted ? { path: f.path, deleted: true } : { path:f.path,sha256:f.sha256 })) })).digest('hex');
  return { baseSha: config.baseSha, files, totalBytes, digest };
}

export function candidateProgram(config) {
  checkedScope(config);
  return `import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const base=${JSON.stringify(config.baseSha)},allowed=${JSON.stringify(config.allowedPaths)},root='/workspace/mellon';
const git=args=>{const r=spawnSync('git',['-C',root,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','--no-pager',...args],{encoding:'utf8',maxBuffer:1048576});if(r.status!==0)throw new Error('Candidate git read failed.');return r.stdout;};
if(process.getuid()!==10001||git(['rev-parse','HEAD']).trim()!==base)throw new Error('Candidate base mismatch.');
// The worker's PR metadata file is read separately and never becomes candidate content.
const META='.factory-proposal.json';
const changed=[...new Set([...git(['diff','--no-ext-diff','--no-textconv','--name-only','--no-renames','-z',base,'--']).split('\\0'),...git(['ls-files','--others','--exclude-standard','-z']).split('\\0')].filter(p=>p&&p!==META))];
if(!changed.length||changed.some(p=>!allowed.includes(p)))throw new Error('Candidate paths differ from plan.');
const credentials=JSON.parse(fs.readFileSync('/worker-state/pi-agent/auth.json','utf8'));
const secrets=Object.values(credentials).flatMap(c=>[c.access,c.refresh,c.key]).filter(v=>typeof v==='string'&&v.length>10);
let total=0;
const tracked=p=>spawnSync('git',['-C',root,'cat-file','-e',base+':'+p]).status===0;
const files=changed.sort().map(p=>{const target=path.join(root,p);let info;try{info=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT'&&tracked(p))return{path:p,deleted:true};throw new Error('Unsafe candidate file.');}if(!info.isFile()||info.isSymbolicLink()||info.size>131072||!fs.realpathSync(target).startsWith(root+'/'))throw new Error('Unsafe candidate file.');const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;try{data=fs.readFileSync(fd);}finally{fs.closeSync(fd);}total+=data.length;if(total>131072)throw new Error('Candidate too large.');const content=data.toString('utf8');if(!Buffer.from(content).equals(data)||content.includes('\\0')||secrets.some(s=>content.includes(s)))throw new Error('Unsafe candidate content.');return{path:p,content};});
let meta;
try{const target=path.join(root,META),info=fs.lstatSync(target);if(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384){const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;try{raw=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}const v=JSON.parse(raw);if(v&&typeof v.title==='string'&&typeof v.summary==='string'&&!secrets.some(s=>raw.includes(s)))meta={title:v.title.slice(0,200),summary:v.summary.slice(0,5000)};}}catch{}
console.log(JSON.stringify({baseSha:base,files,...(meta?{meta}:{})}));`;
}
