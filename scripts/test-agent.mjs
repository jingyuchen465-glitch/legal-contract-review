import {startPostgres} from './postgres-runtime.mjs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'legal-agent-test-pg-')),password=randomBytes(24).toString('hex');
const database=await startPostgres({databaseDir:path.join(directory,'cluster'),user:'agenttest',password,port});
try{const args=process.argv.slice(2);const p=spawn(process.execPath,['--test','--test-concurrency=1',...(args.length?args:['backend/test/agent*.test.js','backend/test/integration/agent*.test.js'])],{stdio:'inherit',windowsHide:true,env:{...process.env,DATABASE_URL:`postgres://agenttest:${password}@127.0.0.1:${port}/postgres`,SESSION_SECRET:randomBytes(32).toString('hex'),TOKEN_SECRET:randomBytes(32).toString('hex')}});process.exitCode=await new Promise((r,j)=>{p.on('error',j);p.on('exit',r);});}finally{await database.stop();const relative=path.relative(os.tmpdir(),directory);if(!relative.startsWith('..')&&!path.isAbsolute(relative))await fs.rm(directory,{recursive:true,force:true});}
