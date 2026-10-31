const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
async function main(){const root=path.resolve(__dirname,'..'),file=path.join(root,'.local','initial-admin.txt');await fs.mkdir(path.dirname(file),{recursive:true});if(await fs.stat(file).catch(()=>null)){console.log('初始化账号说明已存在，未覆盖。');return;}const password=crypto.randomBytes(18).toString('base64url');const result=spawnSync(process.execPath,['backend/pilot/cli.js','bootstrap'],{cwd:root,env:{...process.env,BOOTSTRAP_PASSWORD:password},stdio:'inherit',windowsHide:true});if(result.status)process.exit(result.status);await fs.writeFile(file,`本机开发初始化账号\n账号：admin\n密码：${password}\n访问：http://localhost:8080\n初始角色仅系统管理员；在账号与角色页面按需配置法务、发布人、业务人员。\n若数据库已有admin账号，本次不会覆盖密码。请使用原账号。\n`,{flag:'wx',mode:0o600});console.log('初始账号说明已保存到 .local/initial-admin.txt（Git忽略）。');}
main().catch(e=>{console.error(e.code||e.message);process.exit(1);});
