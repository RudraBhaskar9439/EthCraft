"""Install pinned voice dependencies and a loopback-only UDP transport; preserve the owned game."""
import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import uuid
import mumbai_city_host as city
import laptop_host as laptop

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'.local/voice'
NETWORK='agentcity-voice-local'
RELAY='agentcity-voice-transport'
OWNER='agentcity-local-voice'
MAC_LAUNCHER=Path('/Applications/TLauncher.app')

def load(path):return json.loads(path.read_text())
def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.write_text(json.dumps(data,indent=2)+'\n');path.chmod(0o600)
def run(args,**kwargs):return subprocess.run(args,cwd=ROOT,check=True,capture_output=True,**kwargs)
def inspect(kind,name):
    p=subprocess.run(['docker',kind,'inspect',name],capture_output=True,text=True)
    return json.loads(p.stdout)[0] if p.returncode==0 else None

def artifact(prefix):
    item=next(x for x in load(ROOT/'config/voice-dependencies.json')['artifacts'] if x['version'].startswith(prefix))
    path=ROOT/'.local/voice-deps'/item['file']
    if not path.exists():path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(urllib.request.urlopen(item['url'],timeout=60).read())
    if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise RuntimeError('voice_dependency_hash_changed')
    return path

def mac_permissions():
    app=MAC_LAUNCHER
    info=app/'Contents/Info.plist';executable=app/'Contents/MacOS/TLauncher'
    original_info=info.read_bytes();original_executable=executable.read_bytes();metadata=plistlib.loads(original_info)
    record=BASE/'mac-launcher.json'
    previous=load(record) if record.exists() else {}
    owned_script=b'#!/bin/sh\nset -eu\napp_contents="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport JAVA_HOME="$app_contents/Resources/Java/Contents/Home"\nexec "$JAVA_HOME/bin/java" -Xdock:name=TLauncher -jar "$app_contents/Resources/TLauncher.jar"\n'
    if metadata.get('CFBundleIdentifier')!='local.tlauncher.launcher' or info.stat().st_uid!=os.getuid() or (original_executable!=owned_script and hashlib.sha256(original_executable).hexdigest()!=previous.get('executableSha256')):
        raise RuntimeError('owned_local_tlauncher_wrapper_required')
    output=BASE/'MacLauncher';source=ROOT/'tools/voice/MacLauncher.m'
    run(['xcrun','clang','-fobjc-arc','-framework','AppKit','-framework','AVFoundation',str(source),'-o',str(output)],timeout=60)
    backup=BASE/'launcher-backups'/uuid.uuid4().hex;backup.mkdir(parents=True,mode=0o700)
    (backup/'Info.plist').write_bytes(original_info);(backup/'TLauncher').write_bytes(original_executable)
    had_signature=(app/'Contents/_CodeSignature').exists()
    if had_signature:shutil.copytree(app/'Contents/_CodeSignature',backup/'_CodeSignature')
    try:
        metadata['NSMicrophoneUsageDescription']='Allow microphone access to speak privately to your EthCraft Minecraft agents.'
        metadata['CFBundleVersion']='2'
        info.write_bytes(plistlib.dumps(metadata));shutil.copyfile(output,executable);executable.chmod(0o755)
        run(['codesign','--force','--sign','-',str(app)],timeout=60)
        run(['codesign','--verify','--strict',str(app)],timeout=30)
        run([str(executable),'--check'],timeout=10)
        run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister','-f',str(app)],timeout=30)
    except Exception:
        info.write_bytes(original_info);executable.write_bytes(original_executable);executable.chmod(0o755)
        shutil.rmtree(app/'Contents/_CodeSignature',ignore_errors=True)
        if had_signature:shutil.copytree(backup/'_CodeSignature',app/'Contents/_CodeSignature')
        raise
    write(record,{'app':str(app),'backup':str(backup),'executableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'permissionBypass':False})
    return {'installed':True,'app':str(app),'restartLauncherRequired':True,'userMustApproveMicrophone':True,'existingGameDataPreserved':True}

def prepare(runtime):
    target=runtime/'plugins';target.mkdir(exist_ok=True)
    shutil.copyfile(artifact('bukkit-'),target/'voicechat.jar')
    write(target/'AgentCity/voice-local.json',{'version':1,'enabled':True})
    config=target/'voicechat/voicechat-server.properties';config.parent.mkdir(exist_ok=True)
    controls={'port':'24454','bind_address':'0.0.0.0','voice_host':'127.0.0.1:24454','force_voice_chat':'false','allow_recording':'false'}
    old=config.read_text().splitlines() if config.exists() else []
    config.write_text('\n'.join(l for l in old if l.split('=',1)[0] not in controls)+'\n'+'\n'.join(k+'='+v for k,v in controls.items())+'\n')
    config.chmod(0o600)

def client():
    game=Path.home()/'Library/Application Support/minecraft'
    java=game/'runtime/java-runtime-delta/osx-arm64/java-runtime-delta/jre.bundle/Contents/Home/bin/java'
    installer=artifact('installer-')
    if not java.is_file():raise RuntimeError('minecraft_client_java_required')
    result=run([str(java),'-jar',str(installer),'client','-dir',str(game),'-mcversion','1.21.11','-loader','0.20.1','-noprofile'],timeout=180)
    (BASE/'fabric-install.log').write_bytes(result.stdout+result.stderr)
    source=artifact('fabric-');mods=game/'mods';mods.mkdir(exist_ok=True)
    previous=list(mods.glob('voicechat*.jar'))
    if any(p.name!=source.name for p in previous):raise RuntimeError('existing_other_voice_mod_requires_review')
    shutil.copyfile(source,mods/source.name)
    profile='fabric-loader-0.20.1-1.21.11'
    if not (game/'versions'/profile/(profile+'.json')).is_file():raise RuntimeError('fabric_profile_missing')
    write(BASE/'client.json',{'profile':profile,'gameDirectory':str(game),'mod':source.name})
    return {'installed':True,'profile':profile,'existingProfilesPreserved':True}

def transport():
    active=load(laptop.ACTIVE);laptop.owned(active)
    network=inspect('network',NETWORK)
    if network is None:
        run(['docker','network','create','--label','agentcity.owner='+OWNER,NETWORK]);network=inspect('network',NETWORK)
    if network.get('Labels',{}).get('agentcity.owner')!=OWNER:raise RuntimeError('unowned_voice_network')
    attached=network.get('Containers') or {}
    if not any(x.get('Name')==active['container'] for x in attached.values()):run(['docker','network','connect','--alias','agentcity-minecraft',NETWORK,active['container']])
    built=ROOT/'.local/voice-transport';built.mkdir(parents=True,exist_ok=True)
    source=ROOT/'tools/voice/DatagramRelay.java';digest=hashlib.sha256(source.read_bytes()).hexdigest()
    run(['docker','run','--rm','--pull','never','--network','none','--user',f'{os.getuid()}:{os.getgid()}','--mount',f'type=bind,src={source.parent},dst=/source,readonly','--mount',f'type=bind,src={built},dst=/output',active['javaImage'],'javac','--release','25','-d','/output','/source/DatagramRelay.java'])
    actual=inspect('container',RELAY)
    if actual:
        if actual['Config'].get('Labels',{}).get('agentcity.owner')!=OWNER or actual['HostConfig']['PortBindings']!={'24454/udp':[{'HostIp':'127.0.0.1','HostPort':'24454'}]}:raise RuntimeError('unowned_voice_transport')
        if actual['Config'].get('Labels',{}).get('agentcity.source')==digest:
            if not actual['State']['Running']:run(['docker','start',RELAY])
            return {'running':True,'address':'127.0.0.1:24454/udp'}
        run(['docker','stop','--time','10',RELAY]);run(['docker','rm',RELAY])
    run(['docker','run','--detach','--pull','never','--name',RELAY,'--network',NETWORK,'--label','agentcity.owner='+OWNER,'--label','agentcity.source='+digest,'--publish','127.0.0.1:24454:24454/udp','--mount',f'type=bind,src={built},dst=/relay,readonly','--memory','256m','--cpus','0.5',active['javaImage'],'java','-Xmx32m','-Dsun.net.inetaddr.ttl=5','-cp','/relay','DatagramRelay','agentcity-minecraft'])
    write(BASE/'transport.json',{'owner':OWNER,'container':RELAY,'network':NETWORK,'sourceSha256':digest,'serverContainer':active['container']})
    return {'running':True,'address':'127.0.0.1:24454/udp'}

def upgrade():
    runtime=Path(load(laptop.ACTIVE)['runtime']);files=[runtime/'plugins/voicechat.jar',runtime/'plugins/AgentCity/voice-local.json',runtime/'plugins/voicechat/voicechat-server.properties']
    old={p:p.read_bytes() if p.exists() else None for p in files}
    def restore(_runtime):
        for path,data in old.items():
            if data is None:path.unlink(missing_ok=True)
            else:path.write_bytes(data)
    result=city.upgrade(prepare=prepare,rollback_prepare=restore)
    result['voiceTransport']=transport();write(BASE/'settings.json',{'version':1,'enabled':True})
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['client','mac-permissions','isolate','upgrade','transport','status']);args=parser.parse_args();BASE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with city.lease():
        if args.action=='client':result=client()
        elif args.action=='mac-permissions':result=mac_permissions()
        elif args.action=='isolate':result=city.isolate(prepare=prepare)
        elif args.action=='upgrade':result=upgrade()
        elif args.action=='transport':result=transport()
        else:
            a=load(laptop.ACTIVE);result={'game':a['container'],'transportRunning':bool((inspect('container',RELAY) or {}).get('State',{}).get('Running'))}
        print(json.dumps(result))
if __name__=='__main__':main()
