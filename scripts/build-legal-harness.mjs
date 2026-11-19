import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { x } from 'tar';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const commit='fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159';
const digest='44926eb97c791d1b7a640a0146aa1c522aae7c21a8e238576820d01445cff976';
const target=path.resolve(process.env.LEGAL_HARNESS_ROOT||path.join(root,'.local/legal-harness'));
const archive=path.join(root,'.local/harness-upstream/fcc0ad46.tar.gz');
if(Number(process.versions.node.split('.')[0])<24 || Number(process.versions.node.split('.')[0])===24&&Number(process.versions.node.split('.')[1])<9)throw Error('Harness requires Node >=24.9');
await fs.mkdir(path.dirname(archive),{recursive:true});
let bytes=await fs.readFile(archive).catch(()=>null);
if(!bytes){const r=await fetch(`https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/${commit}`);if(!r.ok)throw Error('Upstream download failed: '+r.status);bytes=Buffer.from(await r.arrayBuffer());await fs.writeFile(archive,bytes);}
if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('Pinned upstream archive integrity mismatch');
await fs.mkdir(target,{recursive:true});
const marker=path.join(target,'.legal-source-commit');
const previous=await fs.readFile(marker,'utf8').catch(()=>null);
if(previous&&previous.trim()!==commit)throw Error('Runtime directory belongs to a different source version');
if(!previous){if((await fs.readdir(target)).length)throw Error('Use an empty runtime directory');await x({file:archive,cwd:target,strip:1});await fs.writeFile(marker,commit);}
function run(args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{cwd:target,stdio:'inherit',env:process.env,windowsHide:true});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Build command failed: '+code)));});}
const npmCli=process.env.npm_execpath||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
await run([npmCli,'exec','--yes','--package=pnpm@11.28.5','--','pnpm','install','--frozen-lockfile','--ignore-scripts']);
// The source runtime uses the official POSIX flock addon for durable session
// locks. Windows uses the upstream Windows path and requires no host addon.
if (process.platform === 'linux' || process.platform === 'darwin') {
  await run(['--import','tsx','native/system/scripts/build.ts','--host-addon-only']);
}
const esbuilds=(await fs.readdir(path.join(target,'node_modules/.pnpm'))).filter(n=>n.startsWith('esbuild@0.28.2'));
if(!esbuilds.length)throw Error('Pinned upstream esbuild dependency unavailable');
await run([`node_modules/.pnpm/${esbuilds[0]}/node_modules/esbuild/bin/esbuild`,'packages/sdk/client/src/index.ts','--bundle','--platform=node','--format=esm','--target=es2024','--tsconfig=tsconfig.base.json','--outfile=packages/sdk/client/lib/index.js']);
const extension=path.join(target,'apps/cli/legal-extension');await fs.mkdir(extension,{recursive:true});
for(const file of ['plugin.mjs','compaction.mjs','probe.mjs'])await fs.copyFile(path.join(root,'runtime/legal-harness',file),path.join(extension,file));
await fs.copyFile(path.join(target,'LICENSE'),path.join(extension,'UPSTREAM-MIT-LICENSE'));
const inventory=[];for(const folder of await fs.readdir(path.join(target,'node_modules/.pnpm'))){const modules=path.join(target,'node_modules/.pnpm',folder,'node_modules');for(const name of await fs.readdir(modules).catch(()=>[])){const names=name.startsWith('@')?(await fs.readdir(path.join(modules,name))).map(n=>name+'/'+n):[name];for(const n of names){try{const p=JSON.parse(await fs.readFile(path.join(modules,n,'package.json'),'utf8'));inventory.push({name:p.name,version:p.version,license:p.license||'SEE PACKAGE LICENSE'});}catch{}}}}
await fs.writeFile(path.join(extension,'dependency-licenses.json'),JSON.stringify([...new Map(inventory.map(p=>[p.name+'@'+p.version,p])).values()],null,2));
await fs.writeFile(path.join(target,'legal-runtime.json'),JSON.stringify({commit,archiveSha256:digest,sdk:'packages/sdk/client/lib/index.js',profile:'sdk-minimal',deployment:'official-source-cli',node:process.version,pnpm:'11.28.5'},null,2));
console.log('Legal Harness runtime ready: '+target);
