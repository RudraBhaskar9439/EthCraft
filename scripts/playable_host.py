"""Clone the saved local calculator into a persistent playable pilot; preserve source."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
import http.client
import time
import socket

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/playable-world'


def call(args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def load(path):
    return json.loads(path.read_text())


def launch_worker():
    launch_console()
    ensure_renderer()
    spec = importlib.util.spec_from_file_location('fresh_bridge', ROOT / 'scripts/fresh_world.py')
    fresh = importlib.util.module_from_spec(spec); spec.loader.exec_module(fresh)
    fresh.ensure_inference()
    # WSL can enter the same checkout through a Docker bind-mount alias. Use the
    # stored runtime's canonical root so PID/agent leases keep one host identity.
    canonical_root = Path(load(BASE / 'active.json')['runtime']).parents[2]
    script = str(canonical_root / 'scripts/playable_worker.mjs')
    pidfile = BASE / 'worker.pid'
    if pidfile.exists():
        try:
            command = Path('/proc/' + pidfile.read_text().strip() + '/cmdline').read_bytes()
            if script.encode() in command:
                return
        except OSError:
            pass
    with (BASE / 'worker.log').open('ab') as output:
        process = subprocess.Popen(['node', '--require', str(canonical_root / 'scripts/playable_rpc_dns.cjs'), script], cwd=ROOT, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    pidfile.write_text(str(process.pid))


def ensure_renderer():
    """Start only the isolated owned renderer; absent image leaves game usable."""
    name, image = 'agentcity-world-renderer', 'agentcity-world-renderer:1.33.0'
    candidate = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True, text=True)
    if candidate.returncode:
        print('World images await: docker build -t agentcity-world-renderer:1.33.0 renderer')
        return False
    image_id = json.loads(candidate.stdout)[0]['Id']
    existing = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
    ports = {'8793/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8793'}]}
    if existing.returncode == 0:
        actual = json.loads(existing.stdout)[0]
        host = actual['HostConfig']
        if (actual['Config']['Labels'].get('agentcity.owner') != 'native-world-renderer'
                or actual['Image'] != image_id or host['PortBindings'] != ports
                or not host['ReadonlyRootfs'] or actual['Config']['User'] != '10002:10002'
                or actual.get('Mounts') or not host.get('Init')):
            raise RuntimeError('Renderer container identity or isolation differs; it was not changed.')
        if not actual['State']['Running']:
            call(['docker', 'start', name], capture_output=True)
    else:
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', 8793)) == 0:
                raise RuntimeError('Renderer port belongs to an unverified process.')
        call(['docker', 'run', '-d', '--init', '--name', name, '--label', 'agentcity.owner=native-world-renderer',
              '--read-only', '--user', '10002:10002', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
              '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
              '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=10002,gid=10002,mode=0700',
              '-p', '127.0.0.1:8793:8793', image_id], capture_output=True)
    return True


def launch_console():
    canonical_root = Path(load(BASE / 'active.json')['runtime']).parents[2]
    script = str(canonical_root / 'backend/src/server.mjs')
    pidfile = BASE / 'console.pid'
    if pidfile.exists():
        try:
            args = Path('/proc/' + pidfile.read_text().strip() + '/cmdline').read_bytes().split(b'\0')
            if script.encode() in args and Path(os.fsdecode(args[0])).name in ('node', 'nodejs'):
                return
        except OSError:
            pass
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('127.0.0.1', 8789)) == 0:
            raise RuntimeError('Port 8789 is occupied by an unverified process; it was not stopped.')
    with (BASE / 'console.log').open('ab') as output:
        process = subprocess.Popen(['node', '--require', str(canonical_root / 'scripts/playable_rpc_dns.cjs'), script], cwd=canonical_root, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    pidfile.write_text(str(process.pid))


def wait_ready(data):
    token = (Path(data['runtime']) / 'api-token').read_text().strip()
    for _ in range(180):
        connection = http.client.HTTPConnection('127.0.0.1', 25597, timeout=3)
        try:
            connection.request('GET', '/playable/status', headers={'Authorization': 'Bearer ' + token})
            response = connection.getresponse()
            if response.status == 200 and json.loads(response.read()).get('available'):
                return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(1)
    raise RuntimeError('Playable plugin not ready; inspect the owned server logs.')


def start():
    if os.name != 'posix':
        raise RuntimeError('Use WSL with the prepared Node runtime on PATH.')
    BASE.mkdir(parents=True, exist_ok=True)
    call(['python3', str(ROOT / 'scripts/local_database.py')], capture_output=True)
    active = BASE / 'active.json'
    if active.exists():
        data = load(active)
        actual = json.loads(call(['docker', 'inspect', data['container']], capture_output=True).stdout)[0]
        if actual['Config']['Labels'].get('agentcity.owner') != 'agentcity-playable-pilot':
            raise RuntimeError('Container owner differs.')
        expected = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25596'}],
                    '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25597'}]}
        if actual['HostConfig']['PortBindings'] != expected or actual['Config']['Image'] != data['javaImage']:
            raise RuntimeError('Playable image or loopback bindings differ.')
        if not actual['State']['Running']:
            call(['docker', 'start', data['container']], capture_output=True)
        wait_ready(data)
        launch_worker()
        print(json.dumps({'container': data['container'], 'address': '127.0.0.1:25596'}))
        return
    source_data = load(ROOT / '.local/fresh-world/active.json')
    spec = importlib.util.spec_from_file_location('fresh', ROOT / 'scripts/fresh_world.py')
    fresh = importlib.util.module_from_spec(spec); spec.loader.exec_module(fresh)
    fresh.owned(source_data)
    source = Path(source_data['runtime'])
    checkpoint = load(source / 'construction-checkpoint.json')
    if checkpoint.get('status') != 'built' or checkpoint.get('pending'):
        raise RuntimeError('Finish/reconcile original construction before cloning.')
    call(['docker', 'stop', '--time', '60', source_data['container']], capture_output=True)
    name = 'agentcity-playable-' + uuid.uuid4().hex[:8]
    runtime = BASE / name
    shutil.copytree(source, runtime)
    spec = importlib.util.spec_from_file_location('build', ROOT / 'tests/inspection/build.py')
    build = importlib.util.module_from_spec(spec); spec.loader.exec_module(build)
    artifact, _, _ = build.build()
    shutil.copyfile(artifact, runtime / 'plugins/AgentCity.jar')
    # The original operator fixture only observes the three historical actors.
    # PlayableExperience owns admission/onboarding of the allowlisted players.
    fixture = runtime / 'fixture-source/ConstructionFixture.java'
    text = (ROOT / 'tests/construction/fixture/ConstructionFixture.java').read_text()
    original = 'if (!NAMES.contains(player.getName())) { player.kickPlayer("Local construction fixture identities only"); return; }'
    text = text.replace(original, 'if (!NAMES.contains(player.getName())) return;')
    text = text.replace('resumeMode = Boolean.getBoolean("agentcity.localConstructionResume");', 'resumeMode = true;')
    fixture.write_text(text)
    legacy = ROOT / '.local/compatibility/server'
    jars = sorted([*legacy.glob('libraries/**/*.jar'), *legacy.glob('versions/**/*.jar')])
    cp = ':'.join('/legacy/' + str(p.relative_to(legacy)) for p in jars)
    image = load(ROOT / 'tests/compatibility/versions.json')['java_image']
    args = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=bind,src={runtime},dst=/world', '--mount', f'type=bind,src={legacy},dst=/legacy,readonly', image]
    call(args + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/world/fixture-classes', '/world/fixture-source/ConstructionFixture.java'])
    call(args + ['jar', '--create', '--file', '/world/plugins/AgentCityConstructionFixture.jar', '-C', '/world/fixture-classes', '.'])
    boundary = fresh.module('playable_boundary', 'tests/inspection/run.py')
    players = load(runtime / 'whitelist.json')
    players += [{'uuid': boundary.offline_uuid(n), 'name': n} for n in ['CityAgent1', 'CityAgent2', 'CityAgent3']]
    (runtime / 'whitelist.json').write_text(json.dumps(players, indent=2)+'\n')
    props = (runtime / 'server.properties').read_text().replace('max-players=4', 'max-players=12')
    (runtime / 'server.properties').write_text(props)
    data = {'container': name, 'runtime': str(runtime), 'sourceContainer': source_data['container'],
            'javaImage': source_data['javaImage'], 'owner': 'agentcity-playable-pilot', 'tokenIntegration': False}
    (BASE / 'pending.json').write_text(json.dumps(data, indent=2)+'\n')
    call(['docker', 'run', '--detach', '--pull', 'never', '--name', name, '--label', 'agentcity.owner=agentcity-playable-pilot',
          '--publish', '127.0.0.1:25596:25565', '--publish', '127.0.0.1:25597:25578', '--env', 'AGENTCITY_API_TOKEN',
          '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
          '--memory', '2g', '--cpus', '2', data['javaImage'], 'java', '-Xms512M', '-Xmx1536M',
          '-Dagentcity.localFixture=true', '-Dagentcity.localConstructionResume=true', '-Dagentcity.playable=true',
          '-jar', 'paper.jar', '--nogui'], env=dict(os.environ, AGENTCITY_API_TOKEN=(runtime / 'api-token').read_text()), capture_output=True)
    (BASE / 'pending.json').replace(active)
    wait_ready(data)
    launch_worker()
    print(json.dumps({'container': name, 'address': '127.0.0.1:25596', 'sourcePreserved': True}))


if __name__ == '__main__':
    start()
