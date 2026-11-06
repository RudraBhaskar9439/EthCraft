"""Own disposable GUI-test copy; never stop or write the live Minecraft server."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/investments'
META = BASE / 'native.json'
OWNER = 'ethcraft-investment-native-fixture'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action == 'stop':
        data = json.loads(META.read_text())
        actual = json.loads(run(['docker', 'inspect', data['container']]))[0]
        assert actual['Config']['Labels']['agentcity.owner'] == OWNER
        run(['docker', 'stop', '--time', '30', data['container']])
        run(['docker', 'rm', data['container']])
        data['stopped'] = True
        META.write_text(json.dumps(data, indent=2))
        print(json.dumps({'stopped': True, 'liveServicesChanged': False}))
        return
    assert action == 'start', 'Use start or stop'
    if META.exists():
        assert json.loads(META.read_text()).get('stopped') is True, 'An investment GUI fixture already exists'
    for port in (25986, 25987):
        with socket.socket() as s:
            s.bind(('127.0.0.1', port))
    source = json.loads((ROOT / '.local/mumbai-city/isolated-active.json').read_text())
    assert source['owner'] == 'agentcity-mumbai-city-isolated'
    source_dir = Path(source['runtime']).resolve()
    assert source_dir.is_relative_to(ROOT / '.local/mumbai-city/isolated')
    identifier = uuid.uuid4().hex
    runtime = BASE / 'native' / identifier
    shutil.copytree(source_dir, runtime, ignore=shutil.ignore_patterns('logs', 'crash-reports', 'session.lock'))
    runtime.chmod(0o700)
    shutil.copyfile(ROOT / '.local/plugin-build/AgentCity.jar', runtime / 'plugins/AgentCity.jar')
    token = secrets.token_urlsafe(48)
    (runtime / 'api-token').write_text(token + '\n')
    (runtime / 'api-token').chmod(0o600)
    # Source worlds are copied for GUI testing only; no claim of crash-consistent backup is made.
    data = {'owner': OWNER, 'id': identifier, 'runtime': str(runtime), 'container': 'ethcraft-investments-' + identifier[:8],
            'serverId': source['serverId'], 'gamePort': 25986, 'controlPort': 25987,
            'pluginSha256': hashlib.sha256((runtime / 'plugins/AgentCity.jar').read_bytes()).hexdigest(),
            'fixtureResponses': True, 'liveServicesChanged': False}
    META.write_text(json.dumps(data, indent=2)); META.chmod(0o600)
    run(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'], '--label', 'agentcity.owner=' + OWNER,
         '--publish', '127.0.0.1:25986:25565', '--publish', '127.0.0.1:25987:25578', '--env', 'AGENTCITY_API_TOKEN',
         '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
         '--memory', '2g', '--cpus', '2', source['javaImage'], 'java', '-Xms512M', '-Xmx1536M',
         '-Dagentcity.localFixture=true', '-Dagentcity.playable=true', '-Dagentcity.worldAssets=true',
         '-Dagentcity.discordRequired=true', '-jar', 'paper.jar', '--nogui'], env=dict(os.environ, AGENTCITY_API_TOKEN=token))
    print(json.dumps(data))


if __name__ == '__main__':
    main()
