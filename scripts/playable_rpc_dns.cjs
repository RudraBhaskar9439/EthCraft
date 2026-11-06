'use strict'
// WSL's resolver can be unavailable while the Windows host resolves this RPC.
// Keep the official URL/TLS hostname; scope the fallback to this Node process.
const dns=require('node:dns')
const {execFile}=require('node:child_process')
const {isIPv4}=require('node:net')
const original=dns.lookup.bind(dns)
let cached,pending
dns.lookup=function(hostname,options,callback){
  if(typeof options==='function'){callback=options;options={}}
  return original(hostname,options,(error,address,family)=>{
    if(!error||hostname!=='sepolia.unichain.org'||!process.env.WSL_INTEROP||![0,4,undefined].includes(typeof options==='number'?options:options?.family)||!['EAI_AGAIN','ENOTFOUND'].includes(error.code))return callback(error,address,family)
    const deliver=result=>callback(null,options?.all?[{address:result,family:4}]:result,options?.all?undefined:4)
    if(cached&&Date.now()-cached.at<60000)return deliver(cached.address)
    pending||=new Promise((resolve,reject)=>{
      execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[System.Net.Dns]::GetHostAddresses('sepolia.unichain.org') | Where-Object {$_.AddressFamily -eq 'InterNetwork'} | Select-Object -First 1 -ExpandProperty IPAddressToString"],{timeout:10000,maxBuffer:4096,windowsHide:true},(failed,stdout)=>{
        const result=stdout?.trim()
        if(failed||!isIPv4(result))return reject(error)
        cached={address:result,at:Date.now()};resolve(result)
      })
    }).finally(()=>{pending=null})
    pending.then(deliver,()=>callback(error))
  })
}
