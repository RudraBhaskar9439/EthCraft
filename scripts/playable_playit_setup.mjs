// Preparation only: never starts tmux, a daemon or a public tunnel.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat, chmod, rename, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version='1.1.0',release='https://github.com/playit-cloud/playit-agent/releases/tag/v1.1.0'
const assets=[
 {name:'playit-linux-amd64',sha256:'1ccd3fe491d4f54e71504da001c16fa4718832a5cb7ee2461dce2816c3fbbc07'},
 {name:'playit-cli-linux-amd64',sha256:'d0d61355cadae033595e5671e7b5cf9200f434b4796ce5ccaf55ec77139e18ba'}
].map(value=>({...value,url:'https://github.com/playit-cloud/playit-agent/releases/download/v1.1.0/'+value.name}))
const mode=process.argv[2]||'--manifest'
if(process.argv.length>3||!['--manifest','--prepare','--claim-status'].includes(mode))throw Error('Use --manifest, --prepare or --claim-status')
const sha=value=>createHash('sha256').update(value).digest('hex')
const root=fileURLToPath(new URL('../',import.meta.url))
const privateRoot=resolve(homedir(),'.local/share/agentcity-public-access/playit-v1.1.0')
const paths={privateRoot,daemon:join(privateRoot,'playit-linux-amd64'),cli:join(privateRoot,'playit-cli-linux-amd64'),secretFile:join(privateRoot,'playit.toml'),socket:join(privateRoot,'playit.sock'),setupLog:join(privateRoot,'setup.log'),claimUrlFile:join(privateRoot,'claim-url.txt'),daemonScript:join(privateRoot,'run-daemon.sh'),setupScript:join(privateRoot,'run-setup.sh')}
async function privatePath(path,directory=false){const info=await lstat(path);if(info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||(directory?!info.isDirectory():!info.isFile()))throw Error('PRIVATE_EXT4_OWNER_MODE_REQUIRED')}
async function atomic(path,data,mode=0o600){const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',mode);try{await file.writeFile(data);await file.sync()}finally{await file.close()}await rename(temporary,path);const directory=await open(privateRoot,'r');try{await directory.sync()}finally{await directory.close()}}
function quote(value){return "'"+value.replaceAll("'","'\\''")+"'"}
if(mode==='--manifest'){
 console.log(JSON.stringify({version,release,assets,gameOrigin:'127.0.0.1:8796',paperBackendMustStayPrivate:'127.0.0.1:25596',publicExposureStarted:false}))
}else{
 if(process.platform!=='linux'||!process.env.WSL_DISTRO_NAME||privateRoot.startsWith('/mnt/'))throw Error('WSL_PRIVATE_EXT4_PREPARATION_REQUIRED')
 if(mode==='--prepare'){
  await mkdir(privateRoot,{recursive:true,mode:0o700});await privatePath(privateRoot,true)
  for(const asset of assets){const file=join(privateRoot,asset.name);let existing
   try{await privatePath(file);existing=await readFile(file)}catch(error){if(error.code!=='ENOENT')throw error}
   if(existing){if(sha(existing)!==asset.sha256)throw Error('EXISTING_PLAYIT_BINARY_HASH_MISMATCH');continue}
   const response=await fetch(asset.url,{signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error('OFFICIAL_PLAYIT_DOWNLOAD_UNAVAILABLE')
   const parts=[];let bytes=0;for await(const part of response.body){bytes+=part.length;if(bytes>8000000)throw Error('PLAYIT_BINARY_TOO_LARGE');parts.push(part)}const buffer=Buffer.concat(parts)
   if(sha(buffer)!==asset.sha256)throw Error('OFFICIAL_PLAYIT_CHECKSUM_MISMATCH')
   await atomic(file,buffer,0o700);await chmod(file,0o700);await privatePath(file)
  }
  const daemon='#!/bin/sh\nset -eu\numask 077\nexec '+quote(paths.daemon)+' --secret-path '+quote(paths.secretFile)+' --socket-path '+quote(paths.socket)+' --log-path '+quote(join(privateRoot,'daemon.log'))+' >> '+quote(join(privateRoot,'daemon.stdout.log'))+' 2>&1\n'
  const setup='#!/bin/sh\nset -eu\numask 077\nexec '+quote(paths.cli)+' --socket-path '+quote(paths.socket)+' --stdout setup >> '+quote(paths.setupLog)+' 2>&1\n'
  for(const [file,content]of[[paths.daemonScript,daemon],[paths.setupScript,setup]]){try{await privatePath(file);if(await readFile(file,'utf8')!==content)throw Error('EXISTING_PLAYIT_WRAPPER_CHANGED')}catch(error){if(error.code!=='ENOENT')throw error;await atomic(file,content,0o700)}}
  const directory=join(root,'.local/public-access');await mkdir(directory,{recursive:true,mode:0o700})
  await writeFile(join(directory,'playit-settings.json'),JSON.stringify({version,release,assets,...paths,origin:'127.0.0.1:8796',enabled:false},null,2)+'\n',{mode:0o600})
  const hosting=join(root,'.local/hosting');await mkdir(hosting,{recursive:true,mode:0o700})
  const hostSettings=join(hosting,'playit.json')
  await writeFile(hostSettings,JSON.stringify({version,daemon:paths.daemon,cli:paths.cli,secretPath:paths.secretFile,socketPath:paths.socket,logPath:join(privateRoot,'daemon.log'),privateRoot,setupScript:paths.setupScript,daemonScript:paths.daemonScript,origin:'127.0.0.1:8796',assets,enabled:false},null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({status:'prepared',version,settingsFile:hostSettings,daemonScript:paths.daemonScript,setupScript:paths.setupScript,publicExposureStarted:false,secretPrinted:false}))
 }else{
  await privatePath(privateRoot,true);let secretFilePresent=false
  try{await privatePath(paths.secretFile);secretFilePresent=true}catch(error){if(error.code!=='ENOENT')throw error}
  let claimUrlFile=null
  if(!secretFilePresent){let logs='';try{await privatePath(paths.setupLog);logs=await readFile(paths.setupLog,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
   const urls=logs.match(/https:\/\/playit\.gg\/claim\/[a-f0-9]+/g)||[]
   if(urls.length){await atomic(paths.claimUrlFile,urls.at(-1)+'\n');claimUrlFile=paths.claimUrlFile}
  }
  console.log(JSON.stringify({secretFilePresent,claimUrlFile,claimUrlAvailable:Boolean(claimUrlFile),publicEndpointVerified:false,secretPrinted:false}))
 }
}
