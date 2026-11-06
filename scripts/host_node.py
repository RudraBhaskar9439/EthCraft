"""Persistent WSL/tmux player services. Private control ports never enter a tunnel."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).absolute().parents[1]
ACTIVE = json.loads((ROOT / '.local/playable-world/active.json').read_text())
if ACTIVE.get('owner') != 'agentcity-playable-pilot':
    raise RuntimeError('owned_world_required')
ROOT = Path(ACTIVE['runtime']).parents[2]
BASE = ROOT / '.local/hosting'
STATE = BASE / 'state.json'
NODE = ROOT / '.local/tools/node-v26.3.1-linux-x64/bin/node'
CF = ROOT / '.local/tools/cloudflared-2026.10.3'
CF_HASH = '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0'
SERVICES = ('console', 'worker', 'gateway', 'web-tunnel', 'minecraft-ingress', 'playit', 'inference', 'bore')
ENV = {**os.environ, 'PATH': str(NODE.parent) + ':' + os.defpath}


def load(file):
    return json.loads(file.read_text())


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + '.pending')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(file)


def tmux(*args, check=True):
    return subprocess.run(['tmux', '-L', 'agentcity-host', *args], check=check, capture_output=True, text=True)


def pidfile(service):
    return ROOT / '.local/playable-world' / (service + '.pid') if service in ('console', 'worker') else BASE / (service + '.pid')


def idle():
    runtime = Path(ACTIVE['runtime'])
    tasks = load(runtime / 'personal-agent-tasks.json')['tasks']
    escrow = runtime / 'plugins/AgentCity/inventory-escrow.jsonl'
    operations = {}
    if escrow.exists():
        for line in escrow.read_text().splitlines():
            value = json.loads(line)
            if value.get('kind') != 'authority' and value.get('operationId'):
                operations[value['operationId']] = value
    return all(task['status'] in ('complete', 'blocked', 'paused', 'cancelled') and not task.get('pending') for task in tasks) and not load(runtime / 'plugins/AgentCity/task-region-locks.json') and not any(value.get('phase') == 'intent' for value in operations.values())


def owned_stop(service):
    file = pidfile(service)
    if not file.exists():
        return
    pid = int(file.read_text().strip())
    process = Path('/proc') / str(pid)
    try:
        args = (process / 'cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:
        return
    scripts = {'console': ROOT / 'backend/src/server.mjs', 'worker': ROOT / 'scripts/playable_worker.mjs',
               'gateway': ROOT / 'backend/src/discord/public-gateway.mjs', 'minecraft-ingress': ROOT / 'backend/src/discord/minecraft-ingress.mjs',
               'inference': ROOT / 'scripts/ollama_wsl_bridge.py'}
    valid = service in scripts and str(scripts[service]).encode() in args and Path(os.fsdecode(args[0])).name in (('python3', 'python') if service == 'inference' else ('node', 'nodejs'))
    if service == 'web-tunnel':
        valid = args[0] == str(CF).encode() and b'http://127.0.0.1:8795' in args
    if service == 'playit':
        valid = args[0] == load(BASE / 'playit.json')['daemon'].encode()
    if service == 'bore':
        valid = args[0] == load(BASE / 'bore.json')['binary'].encode() and b'25565' in args and b'bore.pub' in args
    if not valid:
        raise RuntimeError('unverified_service_pid_' + service)
    os.kill(pid, signal.SIGTERM)
    for _ in range(150):
        if not process.exists():
            return
        time.sleep(.1)
    raise RuntimeError('service_stop_pending_' + service)


def publish_origin(origin):
    if not re.fullmatch(r'https://[a-z0-9-]+\.trycloudflare\.com', origin):
        raise RuntimeError('unexpected_tunnel_origin')
    while not idle():
        time.sleep(3)  # Never interrupt physical effects to rotate an account URL.
    previous = load(STATE) if STATE.exists() else {}
    if previous.get('origin') == origin:
        return
    for file in (ROOT / '.local/discord/settings.json', ROOT / '.local/playable-testnet/wallet-settings.json'):
        settings = load(file)
        settings['origin' if file.parent.name == 'discord' else 'playerOrigin'] = origin
        write(file, settings)
    write(STATE, {**previous, 'owner': 'agentcity-host-node', 'origin': origin, 'updatedAt': time.time()})
    for service in ('console', 'worker', 'gateway'):
        owned_stop(service)  # tmux supervisors reload the new exact origin.


def command(service):
    preload = ['--require', str(ROOT / 'scripts/playable_rpc_dns.cjs')]
    scripts = {'console': 'backend/src/server.mjs', 'worker': 'scripts/playable_worker.mjs',
               'gateway': 'backend/src/discord/public-gateway.mjs', 'minecraft-ingress': 'backend/src/discord/minecraft-ingress.mjs'}
    if service in scripts:
        return [str(NODE), *preload, str(ROOT / scripts[service])]
    if service == 'inference':
        return ['/usr/bin/python3', str(ROOT / 'scripts/ollama_wsl_bridge.py')]
    if service == 'web-tunnel':
        if hashlib.sha256(CF.read_bytes()).hexdigest() != CF_HASH:
            raise RuntimeError('cloudflared_checksum_mismatch')
        return [str(CF), 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:8795']
    if service == 'playit':
        settings = load(BASE / 'playit.json')
        return [settings['daemon'], '--secret-path', settings['secretPath'], '--socket-path', settings['socketPath'], '--log-path', settings['logPath']]
    if service == 'bore':
        settings = load(BASE / 'bore.json')
        if settings['relay'] != 'bore.pub' or not 1024 <= settings['requestedPort'] <= 65535 or hashlib.sha256(Path(settings['binary']).read_bytes()).hexdigest() != settings['sha256']:
            raise RuntimeError('bore_configuration_or_checksum_mismatch')
        return [settings['binary'], 'local', '25565', '--local-host', '127.0.0.1', '--to', 'bore.pub', '--port', str(settings['requestedPort'])]
    raise RuntimeError('unknown_service')


def run(service):
    os.umask(0o077)
    BASE.mkdir(parents=True, exist_ok=True)
    log = ROOT / '.local/playable-world' / (service + '.log') if service in ('worker', 'console') else BASE / (service + '.log')
    if service == 'bore':
        settings = load(BASE / 'bore.json')
        previous = settings.get('adoptPid')
        if previous and (Path('/proc') / str(previous)).exists():
            args = (Path('/proc') / str(previous) / 'cmdline').read_bytes().split(b'\0')
            if args[0] != settings['binary'].encode() or b'25565' not in args or b'bore.pub' not in args:
                raise RuntimeError('bore_adoption_owner_mismatch')
            command(service)  # Verify the pinned binary before adopting it.
            pidfile(service).write_text(str(previous))
            while (BASE / 'enabled').exists() and (Path('/proc') / str(previous)).exists():
                time.sleep(1)
    delay = 2
    while (BASE / 'enabled').exists():
        env = dict(ENV)
        if STATE.exists():
            env['AC_PUBLIC_ORIGIN'] = load(STATE).get('origin', '')
        with log.open('ab', buffering=0) as output:
            process = subprocess.Popen(command(service), cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE if service == 'web-tunnel' else output, stderr=subprocess.STDOUT)
            pidfile(service).write_text(str(process.pid))
            if service == 'web-tunnel':
                for line in iter(process.stdout.readline, b''):
                    output.write(line)
                    match = re.search(rb'https://[a-z0-9-]+\.trycloudflare\.com', line)
                    if match:
                        publish_origin(match.group().decode())
            process.wait()
        time.sleep(delay)
        delay = min(delay * 2, 30)


def session_info(name):
    lines = tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_start_command}\t#{pane_pid}', check=False).stdout.splitlines()
    matches = [line.split('\t') for line in lines if line.split('\t', 1)[0] == name]
    if len(matches) != 1 or len(matches[0]) != 3:
        raise RuntimeError('ambiguous_or_missing_owned_tmux_pane_' + name)
    return matches[0][1], int(matches[0][2])


def start_session(service):
    name = 'agentcity-' + service
    target = '=' + name
    invocation = shlex.join(['/usr/bin/python3', str(ROOT / 'scripts/host_node.py'), 'run', service])
    if tmux('has-session', '-t', target, check=False).returncode == 0:
        actual, _ = session_info(name)
        if str(ROOT / 'scripts/host_node.py') not in actual or ('run ' + service) not in actual:
            raise RuntimeError('unverified_tmux_session_' + name)
        return
    tmux('new-session', '-d', '-s', name, '-c', str(ROOT), invocation)


def start():
    if os.name != 'posix' or not shutil.which('tmux'):
        raise RuntimeError('wsl_tmux_required')
    if not idle():
        raise RuntimeError('finish_or_reconcile_physical_task_before_service_handover')
    if STATE.exists() and load(STATE).get('owner') != 'agentcity-host-node':
        raise RuntimeError('host_state_owner_mismatch')
    if not CF.exists():
        url = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-linux-amd64'
        with urllib.request.urlopen(url, timeout=60) as response:
            binary = response.read(50000000)
        if hashlib.sha256(binary).hexdigest() != CF_HASH:
            raise RuntimeError('cloudflared_download_checksum_mismatch')
        CF.parent.mkdir(parents=True, exist_ok=True)
        temporary = CF.with_suffix('.download')
        temporary.write_bytes(binary)
        temporary.chmod(0o755)
        temporary.replace(CF)
    if hashlib.sha256(CF.read_bytes()).hexdigest() != CF_HASH:
        raise RuntimeError('cloudflared_checksum_mismatch')
    BASE.mkdir(parents=True, exist_ok=True)
    (BASE / 'enabled').touch()
    for service in ('console', 'worker'):
        if tmux('has-session', '-t', '=agentcity-' + service, check=False).returncode:
            owned_stop(service)
    start_session('web-tunnel')
    for _ in range(90):
        if STATE.exists() and load(STATE).get('origin'):
            break
        time.sleep(1)
    else:
        raise RuntimeError('web_tunnel_origin_pending_see_private_host_log')
    for service in ('inference', 'console', 'gateway', 'worker'):
        start_session(service)
    if (ROOT / 'backend/src/discord/minecraft-ingress.mjs').exists():
        start_session('minecraft-ingress')
    if (BASE / 'playit.json').exists():
        start_session('playit')
    if (BASE / 'bore.json').exists():
        start_session('bore')
    status()


def status():
    sessions = tmux('list-sessions', '-F', '#{session_name}', check=False)
    current = load(STATE) if STATE.exists() else {}
    print(json.dumps({'host': 'agentcity-host-node', 'origin': current.get('origin'), 'minecraftPublicAddress': current.get('minecraftPublicAddress'),
                      'tmuxSessions': sessions.stdout.splitlines(), 'minecraftPrivateOrigin': '127.0.0.1:25596',
                      'operatorApiPublic': False, 'budget': '$0'}))


def stop():
    if not idle():
        raise RuntimeError('finish_or_reconcile_physical_task_before_stopping_node')
    (BASE / 'enabled').unlink(missing_ok=True)
    for service in ('web-tunnel', 'playit', 'bore', 'minecraft-ingress', 'gateway', 'worker', 'console', 'inference'):
        name = 'agentcity-' + service
        target = '=' + name
        if tmux('has-session', '-t', target, check=False).returncode:
            continue
        actual, supervisor = session_info(name)
        if str(ROOT / 'scripts/host_node.py') not in actual:
            raise RuntimeError('unverified_tmux_session_' + name)
        supervisor_path = Path('/proc') / str(supervisor)
        supervisor_args = (supervisor_path / 'cmdline').read_bytes().split(b'\0')
        if str(ROOT / 'scripts/host_node.py').encode() not in supervisor_args or b'run' not in supervisor_args or service.encode() not in supervisor_args:
            raise RuntimeError('unverified_service_supervisor_' + service)
        # Stop the supervisor first so it cannot replace a child during shutdown.
        os.kill(supervisor, signal.SIGTERM)
        for _ in range(50):
            if not supervisor_path.exists():
                break
            time.sleep(.1)
        else:
            raise RuntimeError('supervisor_stop_pending_' + service)
        owned_stop(service)
        tmux('kill-session', '-t', target, check=False)
    print(json.dumps({'playerServicesStopped': True, 'savedWorldAndDatabasePreserved': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'stop', 'status', 'run'))
    parser.add_argument('service', nargs='?', choices=SERVICES)
    args = parser.parse_args()
    if args.action == 'run':
        if not args.service:
            parser.error('run requires a service')
        run(args.service)
    elif args.action == 'start':
        start()
    elif args.action == 'stop':
        stop()
    else:
        status()
