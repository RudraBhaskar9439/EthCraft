"""Start only AgentCity's owned, loopback PostgreSQL fixture; never alter other containers."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
NAME = 'agentcity-postgres-local'
OWNER = 'agentcity-local-phases-3-8'


def command(*args, **options):
    return subprocess.run(args, text=True, capture_output=True, **options)


def run():
    directory = ROOT / '.local/backend'
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    environment = directory / 'environment.json'
    if environment.exists():
        data = json.loads(environment.read_text())
    else:
        password = secrets.token_urlsafe(32)
        data = {'databaseUrl': f'postgresql://agentcity:{password}@127.0.0.1:55432/agentcity',
                'databasePassword': password, 'fixtureOwner': OWNER}
        environment.write_text(json.dumps(data, indent=2) + '\n')
        environment.chmod(0o600)
    assert data['fixtureOwner'] == OWNER
    existing = command('docker', 'inspect', NAME)
    if existing.returncode == 0:
        actual = json.loads(existing.stdout)[0]
        if actual['Config']['Labels'].get('agentcity.owner') != OWNER:
            raise RuntimeError('The existing container belongs to another task.')
        if not actual['State']['Running']:
            command('docker', 'start', NAME, check=True)
    else:
        database = directory / 'postgres'
        database.mkdir(exist_ok=True)
        command('docker', 'run', '--detach', '--name', NAME,
                '--label', 'agentcity.owner=' + OWNER, '--publish', '127.0.0.1:55432:5432',
                '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=agentcity',
                '--env', 'POSTGRES_DB=agentcity', '--mount', f'type=bind,src={database},dst=/var/lib/postgresql/data',
                IMAGE, env=dict(os.environ, POSTGRES_PASSWORD=data['databasePassword']), check=True)
    for _ in range(60):
        if command('docker', 'exec', NAME, 'pg_isready', '-U', 'agentcity', '-d', 'agentcity').returncode == 0:
            print('AgentCity PostgreSQL is ready on loopback port 55432; credentials remain in ignored local storage.')
            return
        time.sleep(0.5)
    raise TimeoutError('Owned PostgreSQL did not become ready.')


if __name__ == '__main__':
    run()
