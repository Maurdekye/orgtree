// Coordinator runs this against a reviewed COMMIT, never mutable working files.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process'), {createHash} = require('node:crypto');
const repo=path.resolve(__dirname,'..'), revision=process.argv[2];
if (!/^[0-9a-f]{40}$/.test(revision || '')) throw Error('Pass the exact reviewed full commit SHA');
const git=args=>execFileSync('git',['-C',repo,...args]);
if (git(['rev-parse',revision]).toString().trim() !== revision) throw Error('Commit mismatch');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-paired-snapshot-'));
const selected=['engine','tools/boot-engine-task.ps1','tests/probe-boot-paired-root-only.ps1'];
const files={};
for (const row of git(['ls-tree','-rz',revision,'--',...selected]).toString().split('\0').filter(Boolean)) {
  const [meta,name]=row.split('\t');
  if (!/^100(644|755) blob /.test(meta) || name.includes('..') || path.isAbsolute(name)) throw Error('Non-plain source entry');
  const target=path.join(root,name), bytes=git(['show',`${revision}:${name}`]);
  fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes);
  files[name]=createHash('sha256').update(bytes).digest('hex');
}
for(const name of ['engine/service_host.py','engine/process_lifetime.py','tools/boot-engine-task.ps1','tests/probe-boot-paired-root-only.ps1'])
  if (!files[name]) throw Error('Required snapshot file missing: '+name);
fs.writeFileSync(path.join(root,'probe-source.json'),JSON.stringify({commit:revision,files},null,2));
console.log(root);
