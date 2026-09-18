import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { versionName,run } from './update-core.mjs';
const home=resolve(process.env.ATLAS_HOME||`${process.env.LOCALAPPDATA}/AtlasEnglish`);
const current=JSON.parse(await fs.readFile(resolve(home,'current.json'),'utf8'));
const root=resolve(home,'versions',versionName(current.version));
try {
  const response=await fetch('http://localhost:3000/__atlas/update',{signal:AbortSignal.timeout(2000)});
  const state=await response.json();
  const stopped=await fetch('http://localhost:3000/__atlas/client-stop',{method:'POST',headers:{'X-Atlas-Update':state.token}});
  if(!stopped.ok)throw new Error('Đang cập nhật, chưa thể đóng ứng dụng.');
  for(let i=0;i<150;i++){
    try {await fs.access(resolve(home,'data/running.lock'));await new Promise(r=>setTimeout(r,100));}
    catch {break;}
  }
}catch(error){if(!['fetch failed','The operation was aborted due to timeout'].includes(error.message))throw error;}
const action=process.argv[2]||'stop';
if(action!=='stop')console.log(await run(resolve(root,'runtime/node.exe'),['scripts/data.mjs',action,...process.argv.slice(3)],{
  cwd:root,env:{...process.env,ATLAS_DATA_DIR:resolve(home,'data'),ATLAS_BACKUP_DIR:resolve(home,'backups')}}));
console.log('Đã xong. Mở AtlasEnglish.exe để tiếp tục học.');
