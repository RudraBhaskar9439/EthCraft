"""Reuse or start AgentCity's owned, pinned local Arkiv fixture without resetting data."""
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / '.local/backend'
ENVIRONMENT = DIRECTORY / 'arkiv-environment.json'
IMAGE = 'ghcr.io/arkiv-network/arkiv-reth-dev@sha256:f10af16f18f9bcff7b5e809fc74d200867dc552619b05ee352257b542101ea13'
RPC_URL = 'http://127.0.0.1:8557'


def command(*args):
    return subprocess.run(args, text=True, capture_output=True, timeout=30)


def inspect_container(name):
    result = command('docker', 'container', 'inspect', name)
    if result.returncode == 0:
        return json.loads(result.stdout)[0]
    if 'No such container' in result.stderr or 'No such object' in result.stderr:
        return None
    raise RuntimeError('Docker is unavailable; no container was changed.')


def save(data):
    descriptor, name = tempfile.mkstemp(prefix='.arkiv-environment-', dir=DIRECTORY)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
        os.replace(name, ENVIRONMENT)
    finally:
        Path(name).unlink(missing_ok=True)


def validate_container(actual, data):
    labels = actual['Config'].get('Labels') or {}
    if labels.get('agentcity.owner') != data['owner'] or labels.get('agentcity.local-arkiv') != 'true':
        raise RuntimeError('The existing container has a different owner; it was not changed.')
    bindings = {'8545/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8557'}]}
    mounts = [mount for mount in actual['Mounts'] if mount['Destination'] == '/data']
    if (actual['Config']['Image'] != IMAGE or actual['HostConfig']['PortBindings'] != bindings
            or len(mounts) != 1 or mounts[0]['Type'] != 'bind'
            or Path(mounts[0]['Source']).resolve() != Path(data['dataDirectory']).resolve()):
        raise RuntimeError('The owned container configuration differs from the pinned local fixture.')


def require_free_port():
    try:
        with socket.socket() as connection:
            connection.bind(('127.0.0.1', 8557))
    except OSError as error:
        raise RuntimeError('Loopback port 8557 is occupied; the existing service was not changed.') from error


def rpc(method):
    connection = http.client.HTTPConnection('127.0.0.1', 8557, timeout=2)
    try:
        connection.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': []}),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read(65537)
        if response.status != 200 or len(body) > 65536:
            raise RuntimeError('Local Arkiv returned an invalid HTTP response.')
        value = json.loads(body)
        if value.get('id') != 1 or 'error' in value or 'result' not in value:
            raise RuntimeError('Local Arkiv returned an invalid JSON-RPC response.')
        return value['result']
    finally:
        connection.close()


def run():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    DIRECTORY.chmod(0o700)
    if ENVIRONMENT.exists():
        data = json.loads(ENVIRONMENT.read_text())
        owner = data.get('owner', '')
        if not isinstance(owner, str):
            raise RuntimeError('The saved Arkiv owner is invalid.')
        expected_data = DIRECTORY / ('arkiv-data-' + owner[:8])
        if (not re.fullmatch('[0-9a-f]{32}', owner)
                or data.get('container') != 'agentcity-local-arkiv-' + owner[:8]
                or data.get('image') != IMAGE or data.get('rpcUrl') != RPC_URL
                or data.get('localFixtureOnly') is not True
                or Path(data.get('dataDirectory', '')).resolve() != expected_data.resolve()):
            raise RuntimeError('The saved Arkiv environment does not identify this local fixture.')
        ENVIRONMENT.chmod(0o600)
    else:
        require_free_port()
        owner = secrets.token_hex(16)
        data = {'container': 'agentcity-local-arkiv-' + owner[:8], 'owner': owner, 'image': IMAGE,
                'rpcUrl': RPC_URL, 'dataDirectory': str(DIRECTORY / ('arkiv-data-' + owner[:8])),
                'localFixtureOnly': True, 'cleanupRequiresExactOwnerLabel': True}
        save(data)
    actual = inspect_container(data['container'])
    if actual:
        validate_container(actual, data)
    if not actual or not actual['State']['Running']:
        require_free_port()
        cached = command('docker', 'image', 'inspect', IMAGE)
        if cached.returncode != 0:
            raise RuntimeError('The pinned official Arkiv v0.5.1 image is not cached; no image was downloaded.')
        if actual:
            result = command('docker', 'start', data['container'])
        else:
            Path(data['dataDirectory']).mkdir(exist_ok=True)
            arguments = ['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
                         '--label', 'agentcity.local-arkiv=true', '--label', 'agentcity.owner=' + data['owner'],
                         '--publish', '127.0.0.1:8557:8545', '--mount',
                         'type=bind,src=' + data['dataDirectory'] + ',dst=/data',
                         '--memory', '1536m', '--cpus', '1', IMAGE]
            result = command(*arguments)
            data['launchArguments'] = arguments
        if result.returncode != 0:
            raise RuntimeError('The owned Arkiv fixture could not start; existing data was preserved.')
        validate_container(inspect_container(data['container']), data)
    for _ in range(60):
        try:
            chain_id, accounts = rpc('eth_chainId'), rpc('eth_accounts')
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            time.sleep(0.5)
            continue
        if chain_id != '0x539' or not isinstance(accounts, list) or len(accounts) < 2 or any(
                not isinstance(account, str) or not re.fullmatch('0x[0-9a-fA-F]{40}', account) for account in accounts):
            raise RuntimeError('The owned node does not expose the expected chain 1337 and local fixture accounts.')
        data.update(chainId=1337, accounts=accounts)
        save(data)
        print('AgentCity local Arkiv v0.5.1 is ready on loopback port 8557; existing data is preserved.')
        return
    raise TimeoutError('Owned local Arkiv did not become ready; its data was preserved.')


if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
