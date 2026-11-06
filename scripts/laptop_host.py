"""Run an owned laptop testnet world without changing the saved calculator host."""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/playable-world'
ACTIVE = BASE / 'active.json'
OWNER = 'agentcity-playable-pilot'
LAPTOP = 'agentcity-laptop-bank'
ACTORS = ('BankBorrower', 'BankSeller', 'BankBidder')


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


managed = module('laptop_managed_world', 'scripts/maintained_world.py')


def run(args, **kwargs):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=120, **kwargs)
    if result.returncode:
        raise RuntimeError('laptop_command_failed: ' + result.stderr[-800:])
    return result.stdout.strip()


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ports_free():
    for port in (25596, 25597):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError as error:
                raise RuntimeError('unowned_occupied_port_' + str(port)) from error


def owned(data):
    runtime = Path(data['runtime'])
    if data.get('owner') != OWNER or data.get('deploymentOwner') != LAPTOP:
        raise RuntimeError('laptop_active_owner_mismatch')
    if runtime != BASE / data['container'] or not runtime.resolve().is_relative_to(BASE.resolve()):
        raise RuntimeError('laptop_runtime_changed')
    actual = managed.inspect_container(data['container'])
    if actual is None:
        raise RuntimeError('laptop_container_missing')
    labels = actual['Config'].get('Labels') or {}
    if labels.get('agentcity.owner') != OWNER or labels.get('agentcity.laptop-bank') != data['id']:
        raise RuntimeError('laptop_container_owner_mismatch')
    expected = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25596'}],
                '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25597'}]}
    if actual['HostConfig']['PortBindings'] != expected or actual['Config']['Image'] != data['javaImage']:
        raise RuntimeError('laptop_container_profile_changed')
    mounts = actual['Mounts']
    if len(mounts) != 1 or mounts[0]['Destination'] != '/server' or Path(mounts[0]['Source']).resolve() != runtime.resolve():
        raise RuntimeError('laptop_container_mount_changed')
    if sha(runtime / 'plugins/AgentCity.jar') != data['pluginSha256']:
        raise RuntimeError('laptop_plugin_changed_requires_safe_rollout')
    return actual


def native(data, path, body=None):
    token = (Path(data['runtime']) / 'api-token').read_text().strip()
    connection = http.client.HTTPConnection('127.0.0.1', 25597, timeout=5)
    try:
        headers = {'Authorization': 'Bearer ' + token}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        connection.request('POST' if body is not None else 'GET', '/playable/' + path,
                           body=json.dumps(body) if body is not None else None, headers=headers)
        response = connection.getresponse()
        value = json.loads(response.read(2_000_000))
        if response.status != 200:
            raise RuntimeError('laptop_native_' + str(response.status))
        return value
    finally:
        connection.close()


def wait_ready(data):
    end = time.monotonic() + 180
    while time.monotonic() < end:
        try:
            state = native(data, 'status')
            escrow = native(data, 'escrow/status', {})
            properties = native(data, 'property/status', {})
            if state.get('available') is True and isinstance(escrow.get('pendingCount'), int) and properties.get('enabled') is True:
                if properties.get('serverNamespace') != data['serverId']:
                    raise RuntimeError('laptop_namespace_changed')
                return
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            pass
        time.sleep(1)
    raise RuntimeError('laptop_native_startup_not_ready_inspect_owned_logs')


def prepare():
    config, config_sha = managed.configuration()
    source_data, source = managed.active_metadata(config, config_sha)
    source_container = managed.owned_container(source_data, source, config)
    if source_container['State']['Running']:
        raise RuntimeError('saved_source_must_be_stopped_before_clone')
    ports_free()
    source_before = managed.source_manifest(source)
    backup = module('laptop_backup', 'scripts/local_host.py').backup()
    artifact, build, classpath = module('laptop_plugin_build', 'scripts/build_plugin.py').build()
    identifier = uuid.uuid4().hex
    container = 'agentcity-playable-' + identifier[:8]
    server_id = 'laptop-bank-' + identifier
    runtime = BASE / container
    runtime.mkdir(parents=True, mode=0o700)
    plugin = runtime / 'plugins/AgentCity'
    plugin.mkdir(parents=True)
    deployment = load(source / 'plugins/AgentCity/deployment.json')
    old_world = deployment['world']
    new_world = 'agentcity_laptop_bank'
    # Clone blocks only. Historical actors, item inventories and old custody journals stay in the saved source.
    shutil.copytree(source / old_world, runtime / new_world,
                    ignore=shutil.ignore_patterns('players', 'playerdata', 'advancements', 'stats', 'uid.dat', 'session.lock'))
    for name in ('cache', 'libraries', 'versions', 'config'):
        if (source / name).is_dir():
            shutil.copytree(source / name, runtime / name)
    for name in ('paper.jar', 'eula.txt', 'bukkit.yml', 'spigot.yml'):
        if (source / name).is_file():
            shutil.copyfile(source / name, runtime / name)
    if sha(runtime / 'paper.jar') != config['artifacts']['paper']['sha256']:
        raise RuntimeError('laptop_pinned_paper_changed')
    shutil.copyfile(artifact, runtime / 'plugins/AgentCity.jar')
    for name in ('ViaVersion', 'ViaBackwards'):
        source_file = source / 'plugins' / (name + '.jar')
        if sha(source_file) != config['artifacts'][name]['sha256']:
            raise RuntimeError('laptop_dependency_changed')
        shutil.copyfile(source_file, runtime / 'plugins' / source_file.name)
    dependencies = load(ROOT / 'config/property-dependencies.json')['artifacts']
    for dependency in dependencies:
        file = ROOT / '.local/property-deps' / dependency['file']
        if sha(file) != dependency['sha256']:
            raise RuntimeError('laptop_property_dependency_changed')
        shutil.copyfile(file, runtime / 'plugins' / file.name)
    for name in ('blueprint.json', 'tests.json', 'construction-access.json'):
        shutil.copyfile(source / 'plugins/AgentCity' / name, plugin / name)
    now = int(time.time() * 1000)
    deployment.update(serverId=server_id, jobId='laptop-bank-' + identifier, world=new_world,
                      authorizationReference='laptop-testnet-bootstrap-' + identifier,
                      workDeadlineMs=now + 86400000, reviewDeadlineMs=now + 87300000)
    managed.private_json(plugin / 'deployment.json', deployment)
    (plugin / 'bootstrap-grant').write_text(deployment['jobId'] + '\n' + sha(plugin / 'deployment.json') + '\n')
    (plugin / 'world-assets-enabled').write_text('New laptop testnet namespace. No remote ownership projection adopted.\n')
    token = secrets.token_urlsafe(48)
    (runtime / 'api-token').write_text(token + '\n')
    (runtime / 'api-token').chmod(0o600)
    (runtime / 'laptop-bank-fixture').write_text(identifier + '\n')
    (runtime / 'server.properties').write_text('\n'.join([
        'online-mode=false', 'white-list=false', 'server-port=25565', 'enable-rcon=false',
        'spawn-protection=0', 'view-distance=3', 'simulation-distance=3', 'max-players=12',
        'difficulty=peaceful', 'level-name=' + new_world, 'generate-structures=false',
        'motd=AgentCity laptop testnet pilot', 'level-type=minecraft:flat',
        'generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}'
    ]) + '\n')
    fixture_classes = runtime / 'fixture-classes'
    fixture_classes.mkdir()
    compile_base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
                    '--mount', f'type=bind,src={ROOT},dst=/repo,readonly',
                    '--mount', f'type=bind,src={source},dst=/source,readonly',
                    '--mount', f'type=bind,src={runtime},dst=/output', config['java_image']]
    libraries = sorted([*source.glob('libraries/**/*.jar'), *source.glob('versions/**/*.jar')])
    cp = ':'.join('/source/' + str(file.relative_to(source)) for file in libraries)
    run(compile_base + ['javac', '--release', '25', '-proc:none', '-cp', cp, '-d', '/output/fixture-classes',
                        '/repo/tests/bank/LaptopBankStock.java'])
    (fixture_classes / 'plugin.yml').write_text("name: AgentCityWorldFixture\nversion: 1.0\nmain: org.agentcity.fixture.LaptopBankStock\napi-version: '1.21.11'\n")
    run(compile_base + ['jar', '--create', '--file', '/output/plugins/AgentCityWorldFixture.jar', '-C', '/output/fixture-classes', '.'])
    actors = [{'name': name, 'principalId': str(uuid.uuid4()), 'discordId': str(770000000000000001 + i),
               'disclosure': 'Controlled laptop test actor; no human Discord or Privy proof'} for i, name in enumerate(ACTORS)]
    managed.private_json(runtime / 'laptop-fixture-actors.json', {'schema': 'agentcity.laptop-bank-actors.v1', 'actors': actors})
    if source_before != managed.source_manifest(source):
        raise RuntimeError('saved_source_changed_during_clone')
    data = {'schema': 'agentcity.laptop-bank-host.v1', 'id': identifier, 'owner': OWNER, 'deploymentOwner': LAPTOP,
            'container': container, 'runtime': str(runtime), 'serverId': server_id,
            'sourceContainer': source_data['container'], 'sourceRuntime': str(source), 'sourcePreserved': True,
            'databaseBackup': str(backup), 'javaImage': config['java_image'], 'pluginSha256': sha(runtime / 'plugins/AgentCity.jar'),
            'minecraft': '1.21.11', 'scope': 'Loopback testnet pilot; offline controlled identities, no Microsoft/Privy migration claim',
            'tokenIntegration': True, 'paidInferenceEnabled': False}
    managed.private_json(runtime / 'source-files-before.json', source_before)
    managed.private_json(BASE / 'pending.json', data)
    run(['docker', 'run', '--detach', '--pull', 'never', '--name', container,
         '--label', 'agentcity.owner=' + OWNER, '--label', 'agentcity.laptop-bank=' + identifier,
         '--publish', '127.0.0.1:25596:25565', '--publish', '127.0.0.1:25597:25578', '--env', 'AGENTCITY_API_TOKEN',
         '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
         '--memory', '2g', '--cpus', '2', config['java_image'], 'java', '-Xms512M', '-Xmx1536M',
         '-Dagentcity.localFixture=true', '-Dagentcity.playable=true', '-Dagentcity.worldAssets=true',
         '-Dagentcity.discordRequired=true', '-jar', 'paper.jar', '--nogui'], env=dict(os.environ, AGENTCITY_API_TOKEN=token))
    (BASE / 'pending.json').replace(ACTIVE)
    return data


def pid_matches(pid, script):
    try:
        command = subprocess.check_output(['ps', '-p', str(int(pid)), '-o', 'command='], text=True).strip()
        return str(script) in shlex.split(command)
    except (ValueError, subprocess.CalledProcessError):
        return False


def actors(data):
    script = ROOT / 'tests/bank/native-laptop.mjs'
    record = BASE / 'native-actors-process.json'
    if record.exists():
        previous = load(record)
        if pid_matches(previous.get('pid'), script):
            return {'running': True, 'pid': previous['pid']}
    log = BASE / 'native-actors.log'
    with log.open('ab') as output:
        log.chmod(0o600)
        process = subprocess.Popen([shutil.which('node'), str(script), '--serve', '--seller-play'], cwd=ROOT, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    managed.private_json(record, {'owner': LAPTOP, 'pid': process.pid, 'script': str(script), 'container': data['container']})
    return {'running': True, 'pid': process.pid}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status', 'actors', 'stop'])
    args = parser.parse_args()
    if args.action == 'start':
        BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
        BASE.chmod(0o700)
        data = load(ACTIVE) if ACTIVE.exists() else prepare()
        actual = owned(data)
        if not actual['State']['Running']:
            ports_free()
            run(['docker', 'start', data['container']])
        wait_ready(data)
        print(json.dumps({'ready': True, 'container': data['container'], 'serverId': data['serverId'],
                          'address': '127.0.0.1:25596', 'sourcePreserved': True, 'paidInferenceEnabled': False}))
        return
    if not ACTIVE.exists():
        raise RuntimeError('laptop_host_not_created')
    data = load(ACTIVE)
    actual = owned(data)
    if args.action == 'actors':
        if not actual['State']['Running']:
            raise RuntimeError('laptop_native_not_running')
        wait_ready(data)
        print(json.dumps(actors(data)))
    elif args.action == 'stop':
        record = BASE / 'native-actors-process.json'
        if record.exists():
            process = load(record)
            if process.get('owner') == LAPTOP and pid_matches(process.get('pid'), ROOT / 'tests/bank/native-laptop.mjs'):
                os.kill(process['pid'], signal.SIGTERM)
        if actual['State']['Running']:
            run(['docker', 'stop', '--time', '90', data['container']])
        print(json.dumps({'stopped': True, 'container': data['container']}))
    else:
        result = {'running': actual['State']['Running'], 'container': data['container'], 'serverId': data['serverId'],
                  'address': '127.0.0.1:25596', 'sourcePreserved': data['sourcePreserved'], 'scope': data['scope']}
        if actual['State']['Running']:
            result['native'] = native(data, 'status')
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ready': False, 'error': str(error)}))
        sys.exit(1)
