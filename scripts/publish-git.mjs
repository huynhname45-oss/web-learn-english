import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve,dirname,relative,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashFile,atomicJson } from './update-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const allowed=new Set(['app','runtime','scripts','node_modules','media','AtlasEnglish.exe','Mo-Atlas.cmd','Dong-Atlas.cmd',
  'Sao-luu-du-lieu.cmd','Khoi-phuc-du-lieu.cmd','Tuy-chon-trinh-duyet.cmd','Kiem-tra-goi.cmd','Cap-nhat-GitHub.cmd',
  'README.md','HUONG-DAN.txt','package.json','.gitignore','.gitattributes','atlas-distribution.json',
  'docker-compose.yml','Dockerfile']);
const privateNames=new Set(['.git','data','backups','logs','work','.wrangler','settings.json','current.json','manager.json','downloads','repository.git','package-integrity.json']);
const git=(args)=>{const r=spawnSync('git',['-C',root,'-c','core.autocrlf=false',...args],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});if(r.status!==0)throw new Error(r.stderr||r.stdout);return r.stdout;};
function checkPublicPath(name){
  const parts=name.split('/'),top=parts[0];
  if((!allowed.has(top)&&name!=='package-integrity.json')||
    parts.some(p=>/^(?:presence-owner|presence-relay|local-presence(?:\.ts)?)$/i.test(p))||
    /\.dpapi$/i.test(name)||
    parts.some(p=>/^(?:\.env.*|\.git|\.wrangler|\.mf|backups|logs|work|downloads|repository\.git|settings\.json|current\.json|manager\.json|running\.lock|runtime\.json|credentials(?:\.json)?|secrets(?:\.json)?)$/i.test(p))||
    (parts.some(p=>p.toLowerCase()==='data')&&name!=='app/client/data/toeic-manifest.json'&&!name.startsWith('runtime/'))||
    /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(name)||
    /\.(?:key|pfx|p12|bak|partial|new)$/i.test(name))
    throw new Error(`Tệp riêng hoặc ngoài gói không được phát hành: ${name}`);
}
// Ignore rules do not protect files already tracked or staged with git add -f.
try{
  await fs.lstat(resolve(root,'.git'));
  for(const name of git(['ls-files','-z']).split('\0').filter(Boolean)){
    // Permit removal of the old runtime's metadata cache, never its publication.
    // git add below stages the removal; the final index is checked without exceptions.
    if(name==='node_modules/.mf/cf.json'&&!existsSync(resolve(root,name)))continue;
    checkPublicPath(name);
  }
}catch(error){if(error.code!=='ENOENT')throw error;}
const names=await fs.readdir(root);
for(const name of names)if(!allowed.has(name)&&!privateNames.has(name)&&!name.startsWith('.env'))
  throw new Error(`Tệp ngoài gói ứng dụng: ${name}. Hãy chuyển tệp riêng ra ngoài thư mục phát hành.`);
const map=JSON.parse(await fs.readFile(resolve(root,'app/media-map.json'),'utf8'));
const original=JSON.parse(await fs.readFile(resolve(root,'package-integrity.json'),'utf8'));
const files={};
for(const top of names.filter(n=>allowed.has(n))){
  const path=resolve(root,top),stat=await fs.lstat(path);
  if(stat.isSymbolicLink())throw new Error(`Không phát hành liên kết tới tệp ngoài gói: ${top}`);
  const entries=stat.isDirectory()?await fs.readdir(path,{recursive:true,withFileTypes:true}):[];
  for(const entry of entries)if(entry.isSymbolicLink())throw new Error(`Không phát hành liên kết: ${relative(root,resolve(entry.parentPath,entry.name))}`);
  const paths=stat.isDirectory()?entries.filter(e=>e.isFile()).map(e=>resolve(e.parentPath,e.name)):[path];
  for(const file of paths){
    const name=relative(root,file).replaceAll('\\','/');
    checkPublicPath(name);
    const info=await fs.stat(file);
    if(info.size>=100*1024*1024)throw new Error(`Tệp vượt giới hạn GitHub: ${name}`);
    const digest=await hashFile(file);
    if(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.css','.json','.txt','.html','.md','.yaml','.yml','.toml','.ini','.cfg','.conf','.ps1','.cmd','.bat','.py','.sql','.csv','.xml','.pem'].includes(extname(name).toLowerCase())){
      const text=await fs.readFile(file,'utf8');
      const bundledTlsFixture=name==='node_modules/miniflare/dist/src/index.js'&&digest==='9584409d464f6c21d720b20da3c5dc6e5bdab0393f9cb19b36cb960beaf0958b';
      // Exact pinned Miniflare distribution contains its publicly shipped localhost TLS fixture.
      if(/ATLAS_OWNER_DASHBOARD_ONL[Y]|atlas_admin_[a-f0-9]{64}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|sk-(?:proj-)?[A-Za-z0-9_-]{35,}/.test(text) ||
        (!bundledTlsFixture && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)))
        throw new Error(`Phát hiện chuỗi giống khóa riêng trong ${name}. Dừng để kiểm tra.`);
    }
    files[name]={bytes:info.size,sha256:digest};
  }
}
for(const [url,item] of Object.entries(map)){
  const f=files[item.file];
  if(!f||f.bytes!==item.bytes||f.sha256!==item.sha256)throw new Error(`Media/câu hỏi bị thiếu hoặc đổi không khớp bảng ánh xạ: ${url}`);
}
for(const required of ['scripts/client-manager.mjs','scripts/git-update.mjs','scripts/client-install.mjs','runtime/node.exe','app/server/index.js','AtlasEnglish.exe'])
  if(!files[required])throw new Error(`Gói thiếu ${required}`);
if(process.argv.includes('--publish-prepared')||process.argv.includes('--verify-prepared')){
  if(Object.keys(files).length!==Object.keys(original.files).length ||
    Object.entries(files).some(([name,item])=>original.files[name]?.bytes!==item.bytes||original.files[name]?.sha256!==item.sha256))
    throw new Error('Bản đã kiểm tra bị thay đổi. Hãy build lại từ thư mục code trước khi phát hành.');
}else{
  const distribution={format:'atlas-git-v1',product:'Atlas English',updatedAt:new Date().toISOString(),examCount:43};
  await atomicJson(resolve(root,'atlas-distribution.json'),distribution);
  files['atlas-distribution.json']={bytes:(await fs.stat(resolve(root,'atlas-distribution.json'))).size,sha256:await hashFile(resolve(root,'atlas-distribution.json'))};
  await atomicJson(resolve(root,'package-integrity.json'),{...original,builtAt:new Date().toISOString(),files});
}
console.log(`Đã kiểm tra ${Object.keys(files).length} tệp. Không đưa data, backups hoặc khóa local vào Git.`);
if(!process.argv.includes('--prepare')&&!process.argv.includes('--verify-prepared')){
  if(git(['remote','get-url','origin']).trim()!=='https://github.com/huynhname45-oss/web-learn-english.git')throw new Error('Sai repo phát hành.');
  if(git(['branch','--show-current']).trim()!=='main')throw new Error('Chỉ phát hành từ nhánh main.');
  git(['add','--',...names.filter(n=>allowed.has(n)),'package-integrity.json']);
  const indexed=git(['ls-files','-z']).split('\0').filter(Boolean);
  const expected=new Set([...Object.keys(files),'package-integrity.json']);
  for(const name of indexed){
    checkPublicPath(name);
    if(!expected.delete(name))throw new Error(`Git đang theo dõi tệp ngoài bản kê đã kiểm tra: ${name}`);
  }
  if(expected.size)throw new Error('Git thiếu tệp trong bản kê. Dừng phát hành để tránh gửi gói không đầy đủ.');
  git(['commit','-m',`Update optimized Atlas application ${new Date().toISOString()}`]);
  console.log('Đang đẩy bản tối ưu lên GitHub...');
  git(['push','origin','main']);
  console.log('Thành công. Client sẽ thấy thông báo khi mở lại Atlas.');
}
