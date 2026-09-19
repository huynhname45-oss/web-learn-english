import fs from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expandArchive, verifyCore, atomicJson, hashFile } from './update-core.mjs';

export const remote = 'https://github.com/huynhname45-oss/web-learn-english.git';
export const gitExe = (home) => process.env.ATLAS_GIT_EXE || resolve(home, 'tools/git/cmd/git.exe');
export const gitDir = (home) => resolve(home, 'repository.git');
export async function git(home, args, report = () => {}, timeout = 30 * 60 * 1000) {
  return new Promise((done, reject) => {
    const child = spawn(gitExe(home), ['-c','credential.helper=','-c','core.autocrlf=false','-c','gc.auto=0','-c','maintenance.auto=false',`--git-dir=${gitDir(home)}`,...args], {
      windowsHide:true,timeout,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_CONFIG_NOSYSTEM:'1'} });
    let text='', errors='';
    child.stdout.on('data',b=>{text+=b;if(text.length>4*1024*1024){child.kill();reject(new Error('Git output exceeded limit'));}});
    child.stderr.on('data',b=>{errors=(errors+b).slice(-4000);report(errors);});
    child.once('error',reject);
    child.once('exit',code=>code===0?done(text):reject(new Error(errors.slice(-1000)||`Git failed (${code})`)));
  });
}
function revision(value) {
  if(!/^[a-f0-9]{40}$/.test(value))throw new Error('Mã Git không hợp lệ.');
  return value;
}
export async function latestGit(home) {
  const configured=(await git(home,['remote','get-url','origin'],undefined,10000)).trim();
  if(configured!==(process.env.ATLAS_GIT_REMOTE || remote))throw new Error('Nguồn Git không đúng repo Atlas.');
  const text=await git(home,['ls-remote','origin','refs/heads/main'],undefined,20000);
  const sha=revision(text.trim().split(/\s/)[0]);
  return {mode:'git',revision:sha,version:`git-${sha.slice(0,12)}`};
}
export async function syncMedia(home, root, sha, report = () => {}) {
  revision(sha);
  const receipt=JSON.parse(await fs.readFile(resolve(root,'package-integrity.json'),'utf8'));
  let saved={};
  try{saved=JSON.parse(await fs.readFile(resolve(home,'verified-media.json'),'utf8'));}catch{}
  const next={}, missing=[];
  for(const [name,item] of Object.entries(receipt.files)){
    if(!name.startsWith('media/'))continue;
    const path=resolve(home,name);
    if(!path.startsWith(resolve(home,'media')+sep)||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('Đường dẫn media không hợp lệ.');
    try{
      const stat=await fs.stat(path);
      const known=saved[name];
      if(stat.size===item.bytes && ((known?.sha256===item.sha256 && known.mtime===stat.mtimeMs) || await hashFile(path)===item.sha256)){
        next[name]={sha256:item.sha256,mtime:stat.mtimeMs};continue;
      }
    }catch{}
    missing.push([name,item,path]);
  }
  if(missing.length){
    const child=spawn(gitExe(home),[`--git-dir=${gitDir(home)}`,'cat-file','--batch'],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
    let errorText='';
    child.stderr.on('data',b=>{errorText=(errorText+b).slice(-2000);});
    const exit=new Promise((done,reject)=>{child.once('error',reject);child.once('exit',c=>c===0?done():reject(new Error(errorText||`Git cat-file exit ${c}`)));});
    // Attach a handler immediately; the stream reader reports failures as well.
    void exit.catch(()=>{});
    const iterator=child.stdout[Symbol.asyncIterator]();
    let buffer=Buffer.alloc(0);
    async function more(){const chunk=await iterator.next();if(chunk.done)throw new Error(errorText||'Git media stream ended early');buffer=Buffer.concat([buffer,chunk.value]);}
    async function line(){while(!buffer.includes(10))await more();const end=buffer.indexOf(10),result=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+1);return result;}
    async function bytes(n){while(buffer.length<n)await more();const result=buffer.subarray(0,n);buffer=buffer.subarray(n);return result;}
    try{
      for(const [index,[name,item,path]] of missing.entries()){
        child.stdin.write(`${sha}:${name}\n`);
        const header=(await line()).split(' ');
        if(header[1]!=='blob'||Number(header[2])!==item.bytes)throw new Error(`Git thiếu dữ liệu: ${name}`);
        const content=await bytes(item.bytes);
        if((await bytes(1))[0]!==10||createHash('sha256').update(content).digest('hex')!==item.sha256)
          throw new Error(`Media không toàn vẹn: ${name}`);
        await fs.mkdir(resolve(path,'..'),{recursive:true});
        await fs.writeFile(path+'.new',content);await fs.rename(path+'.new',path);
        next[name]={sha256:item.sha256,mtime:(await fs.stat(path)).mtimeMs};
        report(index+1,missing.length);
      }
      child.stdin.end();await exit;
    }catch(error){child.kill();throw error;}
  }
  await atomicJson(resolve(home,'verified-media.json'),next);
  return missing.length;
}
export async function prepareGit(home,target,stage,report) {
  revision(target.revision);
  let progress = 2;
  await git(home,['fetch','--depth=1','--no-tags','--progress','origin',target.revision],
    (text)=>{
      const receiving=[...text.matchAll(/Receiving objects:\s+(\d+)%[^\r\n]*/g)].at(-1);
      const resolving=[...text.matchAll(/Resolving deltas:\s+(\d+)%/g)].at(-1);
      progress = Math.max(progress, resolving ? 60 + Math.round(Number(resolving[1]) * .08) : receiving ? Math.round(Number(receiving[1]) * .6) : 2);
      const detail = receiving?.[0].match(/,\s*([\d.]+\s*[KMGT]?i?B(?:\s*\|\s*[\d.]+\s*[KMGT]?i?B\/s)?)/)?.[1];
      report('downloading', resolving ? `Đang xử lý thay đổi · ${resolving[1]}%` : `Đang tải bản cập nhật${detail ? ' · ' + detail : ' từ GitHub…'}`, progress);
    });
  const info=JSON.parse(await git(home,['show',`${target.revision}:atlas-distribution.json`]));
  if(info.format!=='atlas-git-v1')throw new Error('Repo chưa có bản đóng gói hoàn chỉnh.');
  const names=(await git(home,['ls-tree','--name-only','-z',target.revision])).split('\0').filter(Boolean);
  if(names.some(n=>['data','backups','.wrangler','.env','settings.json'].includes(n)))throw new Error('Repo chứa đường dẫn dữ liệu riêng; dừng cập nhật.');
  const archive=resolve(home,`core-${target.revision}.zip`);
  // This archive never crosses the network. Store locally without recompressing
  // bundled executables, reducing CPU use while the old application is running.
  await git(home,['archive','--format=zip','-0',`--output=${archive}`,target.revision,'--',...names.filter(n=>n!=='media')]);
  report('verifying','Đang kiểm tra các tệp ứng dụng…',70);
  await expandArchive(archive,stage);await verifyCore(stage);
  report('verifying','Đang kiểm tra và bổ sung media thay đổi…',78);
  await syncMedia(home,stage,target.revision,(count,total)=>report('verifying',`Đang chuẩn bị media ${count}/${total}…`,78+Math.round(count/total*6)));
  await fs.unlink(archive);
}
