"""Loopback host operations. Restore only into a new isolated database; never replace live jobs."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local/ops'
POSTGRES = 'agentcity-postgres-local'
OWNER = 'agentcity-local-phases-3-8'


def execute(arguments, **options):
    result = subprocess.run(arguments, cwd=ROOT, stderr=subprocess.PIPE, timeout=180, **options)
    if result.returncode:
        raise RuntimeError('Local operation failed: ' + arguments[0] + ' ' + arguments[1])
    return result


def private_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')


def owned_postgres():
    settings = json.loads((ROOT / '.local/backend/environment.json').read_text())
    url = urlparse(settings['databaseUrl'])
    if (settings.get('fixtureOwner') != OWNER or url.hostname != '127.0.0.1'
            or url.port != 55432 or url.path != '/agentcity' or url.username != 'agentcity'):
        raise RuntimeError('Owned local PostgreSQL configuration required.')
    actual = json.loads(execute(['docker', 'inspect', POSTGRES], stdout=subprocess.PIPE).stdout)[0]
    if (actual['Config'].get('Labels', {}).get('agentcity.owner') != OWNER
            or not actual['State']['Running']
            or actual['HostConfig']['PortBindings'] != {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '55432'}]}):
        raise RuntimeError('The PostgreSQL owner or loopback binding differs.')
    return actual


def http_json(port, path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        connection.request('POST' if body else 'GET', path, json.dumps(body) if body else None,
                           {'Content-Type': 'application/json'} if body else {})
        response = connection.getresponse()
        data = response.read(2_000_001)
        if response.status != 200 or len(data) > 2_000_000:
            raise RuntimeError('Unhealthy local HTTP service.')
        return json.loads(data)
    finally:
        connection.close()


def occupied(port):
    with socket.socket() as connection:
        return connection.connect_ex(('127.0.0.1', port)) == 0


def access_world():
    path = ROOT / '.local/access-check/active.json'
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if not re.fullmatch('agentcity-access-[a-f0-9]{8}', data.get('container', '')):
        raise RuntimeError('Unknown access-world container.')
    actual = json.loads(execute(['docker', 'inspect', data['container']], stdout=subprocess.PIPE).stdout)[0]
    labels = actual['Config'].get('Labels') or {}
    if labels.get('agentcity.owner') != data.get('owner') or labels.get('agentcity.access-check') != 'true':
        raise RuntimeError('Access-world owner differs.')
    bindings = actual['HostConfig']['PortBindings']
    if bindings != {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25588'}]}:
        raise RuntimeError('Access world must keep its loopback binding.')
    return data, actual


def status():
    checks = {}
    def check(name, action):
        try:
            if not action():
                raise RuntimeError('Not ready.')
            checks[name] = {'ready': True}
        except (OSError, ValueError, RuntimeError, KeyError, http.client.HTTPException, subprocess.SubprocessError):
            checks[name] = {'ready': False}
    check('postgres', lambda: owned_postgres() and execute(['docker', 'exec', POSTGRES, 'pg_isready', '-U', 'agentcity', '-d', 'agentcity'], stdout=subprocess.PIPE).returncode == 0)
    for name, port, chain in [('anvil', 8547, '0x7a69'), ('arkiv', 8557, '0x539')]:
        check(name, lambda port=port, chain=chain: http_json(port, '/', {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []}).get('result') == chain)
    check('ollama', lambda: any(model['name'] == 'qwen3:1.7b' for model in http_json(11434, '/api/tags')['models']))
    check('console', lambda: isinstance(http_json(8789, '/api/status').get('running'), bool))
    check('minecraft', lambda: json.loads(execute(
        [sys.executable, 'scripts/maintained_world.py', 'status'], stdout=subprocess.PIPE
    ).stdout).get('ready') is True)
    return {'ready': all(item['ready'] for item in checks.values()), 'scope': 'loopback laptop preparation; no public exposure or authenticated-human claim', 'services': checks}


def start():
    for script in ['local_database.py', 'local_anvil.py', 'local_arkiv.py']:
        execute([sys.executable, 'scripts/' + script], stdout=subprocess.PIPE)
    LOCAL.mkdir(parents=True, exist_ok=True)
    LOCAL.chmod(0o700)
    for name, port, arguments, environment in [
            ('ollama', 11434, ['ollama', 'serve'], {'OLLAMA_HOST': '127.0.0.1:11434'}),
            ('console', 8789, ['node', 'backend/src/server.mjs'], {'AGENTCITY_LOCAL_PORT': '8789'})]:
        if occupied(port):
            continue
        log = LOCAL / (name + '.log')
        with log.open('ab') as output:
            log.chmod(0o600)
            process = subprocess.Popen(arguments, cwd=ROOT, env=dict(os.environ, **environment), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        private_json(LOCAL / (name + '-' + uuid.uuid4().hex + '.json'), {'pid': process.pid, 'loopbackPort': port})
    world = access_world()
    if world and not world[1]['State']['Running']:
        if occupied(25588):
            raise RuntimeError('Game port is occupied; the existing service was not changed.')
        execute(['docker', 'start', world[0]['container']], stdout=subprocess.PIPE)
    execute([sys.executable, 'scripts/maintained_world.py', 'start'], stdout=subprocess.PIPE)
    for _ in range(30):
        current = status()
        if current['ready']:
            return current
        time.sleep(1)
    return current


def backup():
    actual = owned_postgres()
    directory = LOCAL / 'backups' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex)
    directory.mkdir(parents=True, mode=0o700)
    directory.chmod(0o700)
    holder = subprocess.Popen(['node', 'ops/postgres_snapshot.mjs', 'snapshot'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        snapshot = json.loads(holder.stdout.readline())
        if not re.fullmatch('[A-Fa-f0-9-]+', snapshot['snapshot']):
            raise RuntimeError('Invalid PostgreSQL snapshot identifier.')
        dump = directory / 'database.dump'
        with dump.open('xb') as output:
            dump.chmod(0o600)
            execute(['docker', 'exec', POSTGRES, 'pg_dump', '-U', 'agentcity', '-d', 'agentcity', '--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot['snapshot']], stdout=output)
        manifest = {'createdAt': datetime.now(timezone.utc).isoformat(), 'scope': 'consistent online PostgreSQL snapshot only; not a coordinated chain/world snapshot',
                    'sourceContainer': actual['Id'], 'sourceDatabase': 'agentcity', 'archive': 'database.dump',
                    'sha256': hashlib.sha256(dump.read_bytes()).hexdigest(), 'bytes': dump.stat().st_size,
                    'tables': snapshot['tables'], 'gitRelease': execute(['git', 'rev-parse', 'HEAD'], stdout=subprocess.PIPE).stdout.decode().strip()}
        private_json(directory / 'manifest.json', manifest)
        return directory
    finally:
        if holder.poll() is None:
            holder.communicate('release\n', timeout=10)
        if holder.returncode:
            raise RuntimeError('The read-only snapshot holder failed; do not use this backup.')


def restore_check(directory):
    owned_postgres()
    directory = Path(directory).resolve()
    if not directory.is_relative_to((LOCAL / 'backups').resolve()):
        raise RuntimeError('Restore accepts only an owned ignored backup directory.')
    manifest = json.loads((directory / 'manifest.json').read_text())
    archive = directory / 'database.dump'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('Backup checksum differs; no database was created.')
    database = 'agentcity_restore_' + uuid.uuid4().hex
    execute(['docker', 'exec', POSTGRES, 'createdb', '-U', 'agentcity', '--maintenance-db=postgres', '--template=template0', database], stdout=subprocess.PIPE)
    with archive.open('rb') as source:
        execute(['docker', 'exec', '-i', POSTGRES, 'pg_restore', '-U', 'agentcity', '--dbname=' + database, '--exit-on-error', '--no-owner', '--no-acl'], stdin=source, stdout=subprocess.PIPE)
    restored = json.loads(execute(['node', 'ops/postgres_snapshot.mjs', 'fingerprint', database], stdout=subprocess.PIPE).stdout)
    if restored['tables'] != manifest['tables']:
        raise RuntimeError('Restored table contents differ; isolated database retained for diagnosis.')
    result = {'status': 'pass', 'isolatedDatabase': database, 'tablesVerified': len(restored['tables']),
              'rowsVerified': sum(int(table['rows']) for table in restored['tables']),
              'archiveSha256': manifest['sha256'], 'liveDatabaseReplaced': False,
              'scope': 'actual pg_dump/pg_restore and every restored table fingerprint; no restored worker or chain/world rollback'}
    private_json(directory / ('restore-' + database + '.json'), result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'start', 'backup', 'restore-check'])
    parser.add_argument('backup_directory', nargs='?')
    arguments = parser.parse_args()
    try:
        if arguments.action == 'status':
            result = status()
        elif arguments.action == 'start':
            result = start()
        elif arguments.action == 'backup':
            result = {'backupDirectory': str(backup())}
        else:
            if not arguments.backup_directory:
                parser.error('restore-check requires the ignored backup directory')
            result = restore_check(arguments.backup_directory)
        print(json.dumps(result, indent=2))
        if result.get('ready') is False:
            raise SystemExit(1)
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
