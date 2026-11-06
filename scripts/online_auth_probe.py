"""Start/status only an owned direct online-mode identity probe; never launch a human client."""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/online-auth'
ACTIVE = BASE / 'active.json'
SERVER_COMMAND = ['java', '-Xms512M', '-Xmx1536M', '-jar', 'paper.jar', '--nogui']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*arguments):
    return subprocess.run(arguments, capture_output=True, text=True, timeout=90)


def save(path, value):
    temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2); stream.write('\n')
    temporary.replace(path)


def inspect(data):
    expected = BASE / str(data.get('id', ''))
    pinned = json.loads((ROOT / 'config/minecraft-runtime.json').read_text())
    if (not re.fullmatch('[a-f0-9]{32}', str(data.get('id', ''))) or not re.fullmatch('[a-f0-9]{32}', str(data.get('owner', '')))
            or data.get('container') != 'agentcity-online-auth-' + data['id'][:8]
            or data.get('serverId') != 'agentcity-online-auth-' + data['id']
            or data.get('javaImage') != pinned['java_image']
            or data.get('runtime') != str(expected / 'server') or data.get('tokenFile') != str(expected / 'api-token')):
        raise RuntimeError('Owned authentication metadata differs from its private runtime.')
    result = command('docker', 'inspect', data['container'])
    if result.returncode:
        if 'No such object' in result.stderr or 'No such container' in result.stderr:
            return None
        raise RuntimeError('Docker is unavailable; no existing service was changed.')
    actual = json.loads(result.stdout)[0]
    labels = actual['Config'].get('Labels') or {}
    ports = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25598'}], '25579/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25599'}]}
    mounts = [m for m in actual['Mounts'] if m['Destination'] == '/server']
    if (labels.get('agentcity.online-auth') != 'true' or labels.get('agentcity.owner') != data['owner']
            or actual['Config']['Image'] != data['javaImage'] or actual['Config']['Cmd'] != SERVER_COMMAND or actual['HostConfig']['PortBindings'] != ports
            or len(mounts) != 1 or Path(mounts[0]['Source']).resolve() != Path(data['runtime']).resolve()):
        raise RuntimeError('Exact online-auth container ownership/configuration not established.')
    return actual


def snapshot(data):
    token_path = Path(data['tokenFile'])
    if token_path.stat().st_mode & 0o077 or token_path.stat().st_uid != os.getuid():
        raise RuntimeError('Private authentication API token permissions required.')
    connection = http.client.HTTPConnection('127.0.0.1', 25599, timeout=7)
    try:
        connection.request('GET', '/status', headers={'Authorization': 'Bearer ' + token_path.read_text().strip()})
        result = connection.getresponse()
        if result.status != 200:
            raise RuntimeError('Online authentication authority is unavailable.')
        value = json.loads(result.read(262145))
        if value.get('serverId') != data['serverId'] or not value.get('onlineMode') or not value.get('directAuthentication') or not value.get('ready') or value.get('economicBridge') is not False:
            raise RuntimeError('Direct online-mode authority refused.')
        return value
    finally:
        connection.close()


def status():
    data = json.loads(ACTIVE.read_text())
    expected = BASE / data['id']
    if (data['container'] != 'agentcity-online-auth-' + data['id'][:8] or data['serverId'] != 'agentcity-online-auth-' + data['id']
            or Path(data['runtime']).resolve() != (expected / 'server').resolve() or Path(data['tokenFile']).resolve() != (expected / 'api-token').resolve()):
        raise RuntimeError('Owned auth-probe metadata required.')
    actual = inspect(data)
    if not actual or not actual['State']['Running']:
        raise RuntimeError('Owned authentication probe is not running.')
    for relative, digest in data['artifactHashes'].items():
        if sha(Path(data['runtime']) / relative) != digest:
            raise RuntimeError('Authentication probe artifact changed.')
    value = snapshot(data)
    if value['serverBootId'] != data['serverBootId']:
        raise RuntimeError('Server restarted; refresh the owned start metadata before using sessions.')
    return {'ready': True, 'serverId': data['serverId'], 'serverBootId': value['serverBootId'],
            'gameAddress': '127.0.0.1:25598', 'onlineMode': True, 'directAuthentication': True,
            'connectedAuthenticatedProfiles': len(value['sessions']), 'walletLinksVerified': False,
            'humanVerification': 'Pending actual online-mode joins, player pairing and wallet signatures', 'economicBridge': False}


def start():
    BASE.mkdir(parents=True, exist_ok=True); BASE.chmod(0o700)
    config = json.loads((ROOT / 'config/minecraft-runtime.json').read_text())
    if ACTIVE.exists():
        data = json.loads(ACTIVE.read_text())
        actual = inspect(data)
    else:
        for port in [25598, 25599]:
            with socket.socket() as probe:
                try: probe.bind(('127.0.0.1', port))
                except OSError as error: raise RuntimeError('Auth probe port occupied; existing service was not changed.') from error
        identifier = uuid.uuid4().hex
        directory = BASE / identifier; directory.mkdir(mode=0o700)
        runtime = directory / 'server'; runtime.mkdir()
        source = ROOT / config['qualification']['runtime']
        cached = ROOT / 'tests/compatibility/maintained-candidate/.cache'
        for folder in ['libraries', 'versions', 'cache']:
            shutil.copytree(source / folder, runtime / folder)
        (runtime / 'plugins').mkdir()
        hashes = {}
        for name, target in [('paper', 'paper.jar'), ('ViaVersion', 'plugins/ViaVersion.jar'), ('ViaBackwards', 'plugins/ViaBackwards.jar')]:
            original = cached / ('paper.jar' if name == 'paper' else name + '.jar')
            if sha(original) != config['artifacts'][name]['sha256']:
                raise RuntimeError('Pinned cached authentication runtime artifact differs.')
            shutil.copyfile(original, runtime / target); hashes[target] = sha(original)
        spec = importlib.util.spec_from_file_location('online_auth_build', ROOT / 'tests/identity/online-auth-probe/build.py')
        builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
        jar, source_hashes = builder.build()
        shutil.copyfile(jar, runtime / 'plugins/AgentCityOnlineAuth.jar')
        hashes['plugins/AgentCityOnlineAuth.jar'] = sha(jar)
        token_path = directory / 'api-token'
        descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream: stream.write(secrets.token_hex(32) + '\n')
        data = {'id': identifier, 'owner': uuid.uuid4().hex, 'container': 'agentcity-online-auth-' + identifier[:8],
                'serverId': 'agentcity-online-auth-' + identifier, 'runtime': str(runtime), 'tokenFile': str(token_path),
                'javaImage': config['java_image'], 'artifactHashes': hashes, 'sourceHashes': source_hashes, 'serverBootId': None,
                'purpose': 'direct_online_mode_identity_only', 'economicBridge': False}
        (runtime / 'eula.txt').write_text('# Owner-authorized isolated authentication verification.\neula=true\n')
        (runtime / 'server.properties').write_text('\n'.join(['server-port=25565', 'server-ip=', 'online-mode=true', 'enforce-secure-profile=true',
            'prevent-proxy-connections=false', 'level-name=auth-world-' + identifier[:8], 'level-type=minecraft:flat', 'generate-structures=false',
            'spawn-protection=0', 'gamemode=survival', 'difficulty=peaceful', 'max-players=3', 'view-distance=3', 'simulation-distance=3',
            'enable-rcon=false', 'enable-query=false', 'enable-command-block=false', 'white-list=false', 'motd=AgentCity identity-only online authentication probe', '']))
        save(ACTIVE, data)
        actual = None
    if not actual or not actual['State']['Running']:
        for port in [25598, 25599]:
            with socket.socket() as probe:
                try: probe.bind(('127.0.0.1', port))
                except OSError as error: raise RuntimeError('Auth probe port occupied; existing service was not changed.') from error
        if actual:
            result = command('docker', 'start', data['container'])
        else:
            result = subprocess.run(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
              '--label', 'agentcity.online-auth=true', '--label', 'agentcity.owner=' + data['owner'],
              '--publish', '127.0.0.1:25598:25565', '--publish', '127.0.0.1:25599:25579',
              '--mount', 'type=bind,src=' + data['runtime'] + ',dst=/server', '--workdir', '/server',
              '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2', '--env', 'AGENTCITY_AUTH_API_TOKEN', '--env', 'AGENTCITY_AUTH_SERVER_ID',
              data['javaImage'], *SERVER_COMMAND],
              env=dict(os.environ, AGENTCITY_AUTH_API_TOKEN=Path(data['tokenFile']).read_text().strip(), AGENTCITY_AUTH_SERVER_ID=data['serverId']),
              capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Owned online-mode authentication server could not start; existing worlds were not changed.')
    for _ in range(120):
        try:
            value = snapshot(data)
            data['serverBootId'] = value['serverBootId']; save(ACTIVE, data)
            return status()
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            current = inspect(data)
            if not current or not current['State']['Running']:
                raise RuntimeError('Online-mode probe stopped; inspect its private server log.')
            time.sleep(1)
    raise TimeoutError('Owned online authentication probe did not become ready.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status']); args = parser.parse_args()
    result = start() if args.action == 'start' else status()
    print(json.dumps(result, indent=2))
