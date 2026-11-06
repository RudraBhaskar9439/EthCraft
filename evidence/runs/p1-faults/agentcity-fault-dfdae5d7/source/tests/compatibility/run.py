"""Run an isolated historical Paper/Mineflayer compatibility spike, not a phase gate."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/compatibility'
CACHE = ROOT / '.local/compatibility'


def validate_versions(lock):
    if (lock.get('purpose') != 'isolated_non_token_fixture'
            or lock.get('bind') != '127.0.0.1'
            or lock.get('authentication') != 'offline_fixture_only'
            or lock.get('token_integration') is not False
            or lock.get('production_supported') is not False
            or lock.get('independent_human_participants') != 0):
        raise ValueError('This fixture must remain loopback-only, offline, non-token and non-production.')
    if type(lock.get('port')) is not int or not 1024 <= lock['port'] <= 65535:
        raise ValueError('Invalid fixture port.')
    if lock.get('minecraft') != '1.21.11' or lock.get('mineflayer') != '4.39.0' or lock.get('pathfinder') != '2.4.5':
        raise ValueError('Version change needs a reviewed new compatibility fixture.')
    paper = lock['paper']
    digest = paper.get('sha256', '')
    url = urlparse(paper.get('url', ''))
    if (not re.fullmatch(r'[a-f0-9]{64}', digest) or url.scheme != 'https'
            or url.geturl() != f'https://fill-data.papermc.io/v1/objects/{digest}/paper-1.21.11-132.jar'):
        raise ValueError('Paper must be the exact official checksum-addressed artifact.')
    if not re.fullmatch(r'eclipse-temurin@sha256:[a-f0-9]{64}', lock.get('java_image', '')):
        raise ValueError('Java image must be pinned by digest.')


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def output_text(value):
    return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''


def command(args, timeout=180, check=True, env=None, log_path=None):
    try:
        result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        if log_path is not None:
            log_path.write_text(output_text(exc.stdout)+output_text(exc.stderr))
        raise
    if log_path is not None:
        log_path.write_text(result.stdout+result.stderr)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {(result.stdout+result.stderr)[-7000:]}')
    return result


def cleanup_container(name, run_dir, label):
    errors = []
    removed = False
    actions = [
        (['docker','stop','--time','30',name],45,run_dir/f'{label}-stop.log'),
        (['docker','logs',name],30,run_dir/f'{label}.log'),
        (['docker','rm','--force',name],30,run_dir/f'{label}-remove.log')
    ]
    for args, timeout, log_path in actions:
        try:
            result = command(args,timeout=timeout,check=False,log_path=log_path)
            missing = any(message in result.stderr.lower() for message in ['no such container','no such object'])
            if result.returncode and not missing:
                errors.append(f'{args[1]} failed ({result.returncode}): {(result.stdout+result.stderr)[-2000:]}')
            if args[1] == 'rm':
                removed = result.returncode == 0 or missing
        except Exception as exc:
            errors.append(f'{args[1]}: {exc}')
    return errors, removed


def download_paper(lock, target):
    if target.exists() and file_sha(target) == lock['paper']['sha256']:
        return
    temporary = target.with_suffix('.download')
    request = Request(lock['paper']['url'],headers={'User-Agent':'AgentCity-local-compatibility/0.1'})
    try:
        total = 0
        with urlopen(request, timeout=60) as source, temporary.open('wb') as output:
            while chunk := source.read(1024*1024):
                total += len(chunk)
                if total > 64*1024*1024:
                    raise ValueError('Paper artifact exceeds expected size ceiling.')
                output.write(chunk)
        if file_sha(temporary) != lock['paper']['sha256']:
            raise ValueError('Paper artifact checksum mismatch; refusing execution.')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def server_properties():
    return '\n'.join([
        'server-port=25565','server-ip=','online-mode=false','enforce-secure-profile=false',
        'level-name=compatibility-world','level-type=minecraft:flat','generate-structures=false',
        'spawn-protection=0','gamemode=survival','difficulty=peaceful','max-players=3',
        'view-distance=3','simulation-distance=3','allow-flight=false','enable-rcon=false',
        'enable-query=false','enable-command-block=false','white-list=false',
        'motd=AgentCity isolated compatibility fixture - no tokens or real participants',''
    ])


def run_spike():
    lock = json.loads((FIXTURE/'versions.json').read_text())
    validate_versions(lock)
    CACHE.mkdir(parents=True, exist_ok=True)
    server = CACHE/'server'
    server.mkdir(exist_ok=True)
    (server/'plugins').mkdir(exist_ok=True)
    (server/'eula.txt').write_text('# Local Minecraft development requested by the project owner.\n# https://www.minecraft.net/eula\neula=true\n')
    name = 'agentcity-p0-'+uuid.uuid4().hex[:8]
    (server/'server.properties').write_text(server_properties().replace('level-name=compatibility-world',f'level-name={name}'))
    run_dir = CACHE/'runs'/name
    run_dir.mkdir(parents=True)
    report = {'purpose':'isolated physical compatibility spike only', 'status':'fail','started_at':datetime.now(timezone.utc).isoformat(),
              'versions':lock,'independent_humans':0,'full_phase_gate_passed':False,'steps':[]}
    attempted = False
    original_error = None
    def stop(label):
        nonlocal attempted
        if not attempted:
            return []
        errors, removed = cleanup_container(name,run_dir,label)
        if errors:
            report.setdefault('cleanup_errors',[]).extend(errors)
        attempted = not removed
        return errors
    def start(label):
        nonlocal attempted
        attempted = True
        result = command(['docker','run','--detach','--name',name,'--label','agentcity.compatibility=true',
                          '--publish',f'127.0.0.1:{lock["port"]}:25565','--mount',f'type=bind,src={server},dst=/server',
                          '--workdir','/server','--user',f'{os.getuid()}:{os.getgid()}',
                          '--memory','2g','--cpus','2',lock['java_image'],
                          'java','-Xms512M','-Xmx1536M','-jar','paper.jar','--nogui'],timeout=90,
                          log_path=run_dir/f'{label}-start.log')
        print(f'{label}: waiting for actual Paper startup',flush=True)
        deadline = time.monotonic()+180
        while time.monotonic()<deadline:
            logs = command(['docker','logs',name],timeout=10,check=False,log_path=run_dir/f'{label}.log')
            text = logs.stdout+logs.stderr
            state = command(['docker','inspect','--format','{{.State.Running}}',name],timeout=10,check=False,
                            log_path=run_dir/f'{label}-state.log')
            if state.stdout.strip() != 'true':
                raise RuntimeError('Paper exited during startup: '+text[-7000:])
            if 'Done (' in text:
                (run_dir/f'{label}.log').write_text(text)
                report['steps'].append({'step':label,'status':'pass','container':result.stdout.strip()})
                return
            time.sleep(1)
        raise TimeoutError('Paper startup did not finish within 180 seconds.')
    try:
        package = json.loads((FIXTURE/'package.json').read_text())
        if package.get('dependencies') != {'mineflayer':lock['mineflayer'],'mineflayer-pathfinder':lock['pathfinder']}:
            raise ValueError('Probe dependency versions differ from the reviewed lock.')
        if not (FIXTURE/'package-lock.json').is_file() or not (FIXTURE/'probe.cjs').is_file():
            raise ValueError('Probe source and committed npm lock are required before starting Paper.')
        print('Installing the committed probe graph without dependency lifecycle scripts',flush=True)
        command(['npm','ci','--prefix',str(FIXTURE),'--ignore-scripts','--no-audit','--no-fund'],timeout=180,
                log_path=run_dir/'npm-ci.log')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',lock['port']))
        command(['docker','image','inspect',lock['java_image']],timeout=15,log_path=run_dir/'image-inspect.log')
        java = command(['docker','run','--rm','--network','none',lock['java_image'],'java','-version'],timeout=30,
                       log_path=run_dir/'java-runtime.log')
        report['java_runtime'] = (java.stdout+java.stderr).strip()
        report['node_runtime'] = command(['node','--version'],timeout=10,log_path=run_dir/'node-runtime.log').stdout.strip()
        print('Downloading and verifying official Paper artifact',flush=True)
        download_paper(lock,server/'paper.jar')
        report['actual_paper_sha256'] = file_sha(server/'paper.jar')
        # shortcut: a historical server is used only for an isolated spike; adopt a maintained common version before release.
        existing = server/'plugins/AgentCityCompatibility.jar'
        existing.unlink(missing_ok=True)
        start('bootstrap')
        if stop('bootstrap'):
            raise RuntimeError('Bootstrap container cleanup failed; see cleanup_errors.')
        jars = sorted([*server.glob('libraries/**/*.jar'),*server.glob('versions/**/*.jar')])
        if not jars:
            raise RuntimeError('Paper bootstrap did not produce compile libraries.')
        classpath = ':'.join('/server/'+str(j.relative_to(server)) for j in jars)
        classes = server/'compat-classes'
        if classes.exists():
            shutil.rmtree(classes)
        classes.mkdir()
        print('Compiling fixture against the actual downloaded Paper libraries',flush=True)
        command(['docker','run','--rm','--network','none','--user',f'{os.getuid()}:{os.getgid()}',
                         '--mount',f'type=bind,src={server},dst=/server','--mount',f'type=bind,src={FIXTURE / "plugin"},dst=/source,readonly',
                         lock['java_image'],'javac','--release','21','-cp',classpath,'-d','/server/compat-classes','/source/CompatibilityPlugin.java'],timeout=60,
                         log_path=run_dir/'compile.log')
        shutil.copyfile(FIXTURE/'plugin/plugin.yml',classes/'plugin.yml')
        command(['docker','run','--rm','--network','none','--user',f'{os.getuid()}:{os.getgid()}',
                 '--mount',f'type=bind,src={server},dst=/server',lock['java_image'],
                 'jar','--create','--file','/server/plugins/AgentCityCompatibility.jar','-C','/server/compat-classes','.'],timeout=30,
                 log_path=run_dir/'package-fixture.log')
        report['fixture_plugin_sha256']=file_sha(existing)
        report['steps'].append({'step':'compile_fixture_plugin','status':'pass'})
        start('fixture')
        env = dict(os.environ,AC_COMPAT_PORT=str(lock['port']),AC_COMPAT_REPORT=str(run_dir/'probe-report.json'))
        print('Running actual Mineflayer connection, lever, lamp, inventory, placement and navigation assertions',flush=True)
        command(['node',str(FIXTURE/'probe.cjs')],timeout=100,env=env,log_path=run_dir/'probe.log')
        report['probe'] = json.loads((run_dir/'probe-report.json').read_text())
        if report['probe'].get('status') != 'passed':
            raise RuntimeError('Physical probe did not establish a passing result.')
        report['status']='pass'
    except Exception as exc:
        original_error = exc
        report['status']='fail'
        report['error']=str(exc)
        raise
    finally:
        try:
            stop('final-server')
        except Exception as exc:
            report.setdefault('cleanup_errors',[]).append(str(exc))
        if report.get('cleanup_errors'):
            report['status']='fail'
            report.setdefault('error','Container cleanup failed; see cleanup_errors.')
        report['finished_at']=datetime.now(timezone.utc).isoformat()
        try:
            (run_dir/'run-report.json').write_text(json.dumps(report,indent=2)+'\n')
            print(f'Run evidence retained in {run_dir.relative_to(ROOT)}',flush=True)
        except Exception as exc:
            if original_error is None:
                raise
            original_error.add_note(f'Run report persistence also failed: {exc}')
            print(f'Run report persistence also failed: {exc}',file=sys.stderr)
    if report['status'] != 'pass':
        raise RuntimeError(report['error'])
    print('Physical compatibility spike PASS; formal Phase 0 remains separate',flush=True)
    return report


if __name__ == '__main__':
    try:
        run_spike()
    except Exception as exc:
        print(f'Compatibility spike failed: {exc}',file=sys.stderr)
        raise SystemExit(1)
