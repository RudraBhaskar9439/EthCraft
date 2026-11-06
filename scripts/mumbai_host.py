"""Isolate and roll out one attributed Mumbai world on the owned laptop host."""
import argparse
from contextlib import contextmanager
import fcntl
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/mumbai'
WORLD = 'agentcity_mumbai'
OWNER = 'agentcity-mumbai-isolated'
ISOLATED = BASE / 'isolated-active.json'
MARKER = BASE / 'isolated-verification.json'
JAR = ROOT / '.local/plugin-build/AgentCity.jar'


def module(name, file):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


laptop = module('mumbai_laptop_host', 'scripts/laptop_host.py')
ops = module('mumbai_local_ops', 'scripts/local_host.py')
load, sha, write = laptop.load, laptop.managed.sha, laptop.managed.private_json


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


@contextmanager
def lease():
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (BASE / 'host.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('mumbai_host_operation_already_running') from error
        yield


def inputs():
    manifest = load(BASE / 'artifact-manifest.json')
    artifact = BASE / 'artifact' / WORLD
    config = load(BASE / 'mumbai-world.json')
    require(config['schema'] == 'agentcity.mumbai-world.v1' and config['world'] == WORLD,
            'mumbai_configuration_changed')
    world_id = uuid.UUID(config['worldUuid'])
    require(config == manifest['config'] and Path(manifest['artifactDirectory']) == artifact,
            'mumbai_artifact_binding_changed')
    require(artifact.is_dir() and not artifact.is_symlink() and (artifact / 'level.dat').is_file(),
            'mumbai_artifact_missing')
    require((artifact / 'uid.dat').read_bytes() == world_id.bytes, 'mumbai_artifact_uuid_changed')
    for name, expected in manifest['files'].items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'mumbai_unsafe_artifact_path')
        file = artifact / name
        require(file.is_file() and not file.is_symlink() and sha(file) == expected,
                'mumbai_artifact_file_changed')
    require({str(p.relative_to(artifact)) for p in artifact.rglob('*') if p.is_file()} == set(manifest['files']),
            'mumbai_artifact_file_set_changed')
    require(JAR.is_file() and not JAR.is_symlink(), 'mumbai_built_plugin_required')
    return artifact, config


def world_ids(runtime):
    result = {}
    for file in runtime.glob('*/uid.dat'):
        require(not file.is_symlink(), 'mumbai_world_identity_symlink')
        result[str(file.relative_to(runtime))] = str(uuid.UUID(bytes=file.read_bytes()))
    files = sorted(runtime.glob('*/dimensions/*/*/data/paper/metadata.dat'))
    if files:
        # Paper 26.3 persists dimension UUIDs in NBT, not legacy uid.dat files.
        script = """
const fs = require('fs'), path = require('path');
const nbt = require(path.join(process.argv[1], 'tests/compatibility/node_modules/prismarine-nbt'));
(async () => {
  const result = {};
  for (const file of process.argv.slice(2)) {
    const {parsed} = await nbt.parse(fs.readFileSync(file));
    const parts = nbt.simplify(parsed).data?.uuid;
    if (!Array.isArray(parts) || parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < -2147483648 || x > 2147483647)) throw Error('invalid dimension UUID');
    const bytes = Buffer.alloc(16);
    parts.forEach((value, index) => bytes.writeInt32BE(value, index * 4));
    const hex = bytes.toString('hex');
    result[file] = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  process.stdout.write(JSON.stringify(result));
})().catch(() => process.exit(1));
"""
        require(all(not p.is_symlink() for p in files), 'mumbai_world_identity_symlink')
        command = subprocess.run([shutil.which('node') or 'node', '-e', script, str(ROOT), *map(str, files)],
                                 cwd=ROOT, capture_output=True, text=True, timeout=15)
        require(command.returncode == 0, 'mumbai_dimension_identity_unreadable')
        result.update({str(Path(p).relative_to(runtime)): value for p, value in json.loads(command.stdout).items()})
    require(result, 'mumbai_no_persistent_world_identities')
    return result


def city_paths(runtime):
    primary = load(runtime / 'plugins/AgentCity/deployment.json')['world']
    require(primary and set(primary) <= set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'),
            'mumbai_primary_world_name_changed')
    return runtime / WORLD, runtime / primary / 'dimensions/minecraft' / WORLD


def verify_old_world_ids(runtime, expected, new_world_id):
    actual = world_ids(runtime)
    require(all(actual.get(name) == value for name, value in expected.items()),
            'mumbai_prior_world_identity_changed')
    added = {name: value for name, value in actual.items() if name not in expected}
    require(len(added) == 1 and set(added.values()) == {new_world_id}, 'mumbai_imported_world_identity_changed')


def actor_running(data):
    path = laptop.BASE / 'native-actors-process.json'
    if not path.exists():
        return False
    value = load(path)
    require(value.get('owner') == laptop.LAPTOP and value.get('container') == data['container'],
            'mumbai_actor_process_owner_changed')
    return laptop.pid_matches(value.get('pid'), ROOT / 'tests/bank/native-laptop.mjs')


def quiesce(data, actual):
    actors = actor_running(data)
    if actors:
        value = load(laptop.BASE / 'native-actors-process.json')
        os.kill(value['pid'], signal.SIGTERM)
        end = time.monotonic() + 10
        while laptop.pid_matches(value['pid'], ROOT / 'tests/bank/native-laptop.mjs'):
            require(time.monotonic() < end, 'mumbai_owned_actors_did_not_stop')
            time.sleep(0.1)
    if actual['State']['Running']:
        laptop.run(['docker', 'stop', '--time', '90', data['container']])
    return actual['State']['Running'], actors


def resume(data, running, actors):
    if running:
        if not laptop.owned(data)['State']['Running']:
            laptop.ports_free()
            laptop.run(['docker', 'start', data['container']])
        laptop.wait_ready(data)
        if actors:
            laptop.actors(data)


def native(runtime, port, path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        token = (runtime / 'api-token').read_text().strip()
        headers = {'Authorization': 'Bearer ' + token}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        connection.request('POST' if body is not None else 'GET', '/playable/' + path,
                           body=json.dumps(body) if body is not None else None, headers=headers)
        response = connection.getresponse()
        result = json.loads(response.read(2_000_000))
        require(response.status == 200, 'mumbai_native_not_ready')
        return result
    finally:
        connection.close()


def ready(runtime, port, config, server_id):
    end = time.monotonic() + 180
    while time.monotonic() < end:
        try:
            result = native(runtime, port, 'status')
            value = result.get('mumbai') or {}
            if result.get('available') is True and value.get('ready') is True:
                require(value.get('world') == WORLD and value.get('worldUuid') == config['worldUuid'],
                        'mumbai_loaded_world_binding_changed')
                # The deployment namespace remains the original economic host.
                properties = native(runtime, port, 'property/status', {})
                require(properties.get('serverNamespace') == server_id,
                        'mumbai_deployment_namespace_changed')
                return result
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            pass
        time.sleep(1)
    raise RuntimeError('mumbai_native_startup_not_ready')


def isolated_owned(data):
    require(data.get('owner') == OWNER and len(data.get('id', '')) == 32
            and set(data['id']) <= set('0123456789abcdef'),
            'mumbai_isolation_owner_changed')
    require(data['container'] == 'agentcity-mumbai-' + data['id'][:8], 'mumbai_container_name_changed')
    runtime = Path(data['runtime'])
    require(runtime == BASE / 'isolated' / data['id'] and not runtime.is_symlink()
            and runtime.resolve().is_relative_to((BASE / 'isolated').resolve()),
            'mumbai_isolation_path_changed')
    actual = laptop.managed.inspect_container(data['container'])
    if actual is None:
        return None
    labels = actual['Config'].get('Labels') or {}
    expected = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25996'}],
                '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25997'}]}
    mounts = actual['Mounts']
    require(labels.get('agentcity.owner') == OWNER and labels.get('agentcity.mumbai-isolation') == data['id']
            and actual['HostConfig']['PortBindings'] == expected and actual['Config']['Image'] == data['javaImage']
            and len(mounts) == 1 and mounts[0]['Destination'] == '/server'
            and Path(mounts[0]['Source']).resolve() == runtime.resolve(), 'mumbai_isolation_profile_changed')
    require(sha(runtime / 'plugins/AgentCity.jar') == data['pluginSha256'], 'mumbai_isolation_plugin_changed')
    return actual


def isolate():
    artifact, config = inputs()
    if ISOLATED.exists():
        previous = load(ISOLATED)
        require(isolated_owned(previous) is None and previous.get('cleaned') is True,
                'mumbai_existing_isolation_requires_cleanup')
    for port in (25996, 25997):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    active = load(laptop.ACTIVE)
    actual = laptop.owned(active)
    source = Path(active['runtime'])
    identifier = uuid.uuid4().hex
    runtime = BASE / 'isolated' / identifier
    running, actors = actual['State']['Running'], actor_running(active)
    try:
        quiesce(active, actual)
        require(not any(p.exists() for p in city_paths(source)), 'mumbai_live_world_already_exists')
        ids = world_ids(source)
        shutil.copytree(source, runtime, ignore=shutil.ignore_patterns('logs', 'crash-reports', 'session.lock'))
        require(ids == world_ids(source) == world_ids(runtime), 'mumbai_source_world_ids_changed')
    finally:
        resume(active, running, actors)
    token = secrets.token_urlsafe(48)
    (runtime / 'api-token').write_text(token + '\n')
    (runtime / 'api-token').chmod(0o600)
    shutil.copytree(artifact, runtime / WORLD)
    shutil.copyfile(JAR, runtime / 'plugins/AgentCity.jar')
    write(runtime / 'plugins/AgentCity/mumbai-world.json', config)
    data = {'owner': OWNER, 'id': identifier, 'runtime': str(runtime), 'container': 'agentcity-mumbai-' + identifier[:8],
            'javaImage': active['javaImage'], 'serverId': active['serverId'], 'sourceContainer': active['container'],
            'sourceActiveSha256': sha(laptop.ACTIVE), 'sourceWorldIds': ids, 'worldUuid': config['worldUuid'],
            'pluginSha256': sha(JAR), 'artifactManifestSha256': sha(BASE / 'artifact-manifest.json'),
            'gamePort': 25996, 'controlPort': 25997}
    write(ISOLATED, data)
    laptop.run(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
        '--label', 'agentcity.owner=' + OWNER, '--label', 'agentcity.mumbai-isolation=' + identifier,
        '--publish', '127.0.0.1:25996:25565', '--publish', '127.0.0.1:25997:25578', '--env', 'AGENTCITY_API_TOKEN',
        '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
        '--memory', '2g', '--cpus', '2', data['javaImage'], 'java', '-Xms512M', '-Xmx1536M',
        '-Dagentcity.localFixture=true', '-Dagentcity.playable=true', '-Dagentcity.worldAssets=true',
        '-Dagentcity.discordRequired=true', '-jar', 'paper.jar', '--nogui'], env=dict(os.environ, AGENTCITY_API_TOKEN=token))
    isolated_owned(data)
    ready(runtime, 25997, config, active['serverId'])
    return {'ready': True, 'container': data['container'], 'address': '127.0.0.1:25996', 'activeProfileUnchanged': True}


def cleanup():
    data = load(ISOLATED)
    actual = isolated_owned(data)
    if actual:
        if actual['State']['Running']:
            laptop.run(['docker', 'stop', '--time', '90', data['container']])
        laptop.run(['docker', 'rm', data['container']])
    data['cleaned'] = True
    write(ISOLATED, data)
    return {'removedOwnedContainer': True, 'runtimeRetained': data['runtime']}


def install():
    artifact, config = inputs()
    proof, isolated = load(MARKER), load(ISOLATED)
    require(proof.get('status') == 'pass' and all(proof.get(key) == value for key, value in {
        'pluginSha256': sha(JAR), 'artifactManifestSha256': sha(BASE / 'artifact-manifest.json'),
        'worldUuid': config['worldUuid'], 'serverId': isolated['serverId']}.items()),
        'mumbai_matching_isolated_verification_required')
    report = (ROOT / proof['report']).resolve()
    require(report.is_relative_to((ROOT / 'evidence/runs').resolve()) and report.is_file()
            and sha(report) == proof['reportSha256'] and load(report).get('status') == 'pass',
            'mumbai_actual_isolated_report_required')
    require(sha(laptop.ACTIVE) == isolated['sourceActiveSha256'], 'mumbai_active_profile_changed_since_test')
    active = load(laptop.ACTIVE)
    actual = laptop.owned(active)
    runtime = Path(active['runtime'])
    require(not any(p.exists() for p in city_paths(runtime)) and not (runtime / 'plugins/AgentCity/mumbai-world.json').exists(),
            'mumbai_live_import_exists_do_not_overwrite')
    require(world_ids(runtime) == isolated['sourceWorldIds'], 'mumbai_original_world_identity_changed')
    backup = BASE / 'backups' / uuid.uuid4().hex
    backup.mkdir(parents=True, mode=0o700)
    original_active = laptop.ACTIVE.read_bytes()
    running, actors = actual['State']['Running'], actor_running(active)
    changed = False
    try:
        quiesce(active, actual)
        shutil.copytree(runtime, backup / 'native', ignore=shutil.ignore_patterns('logs', 'crash-reports', 'session.lock'))
        (backup / 'active.json').write_bytes(original_active)
        (backup / 'active.json').chmod(0o600)
        database_backup = ops.backup()
        write(backup / 'rollback.json', {'sourceContainer': active['container'], 'serverId': active['serverId'],
            'worldIds': isolated['sourceWorldIds'], 'databaseBackup': str(database_backup),
            'oldPluginSha256': active['pluginSha256'], 'newPluginSha256': sha(JAR), 'worldUuid': config['worldUuid']})
        (runtime / WORLD).mkdir()
        changed = True
        write(runtime / WORLD / '.agentcity-import.json', {'operation': backup.name, 'worldUuid': config['worldUuid']})
        shutil.copytree(artifact, runtime / WORLD, dirs_exist_ok=True)
        shutil.copyfile(JAR, runtime / 'plugins/AgentCity.jar')
        write(runtime / 'plugins/AgentCity/mumbai-world.json', config)
        updated = {**active, 'pluginSha256': sha(JAR)}
        write(laptop.ACTIVE, updated)
        if running:
            resume(updated, True, False)
            ready(runtime, 25597, config, active['serverId'])
        verify_old_world_ids(runtime, isolated['sourceWorldIds'], config['worldUuid'])
        if running and actors:
            laptop.actors(updated)
        write(BASE / 'installed.json', {'status': 'installed', 'backup': str(backup), 'worldUuid': config['worldUuid'],
            'pluginSha256': updated['pluginSha256'], 'serverId': active['serverId'], 'container': active['container']})
        write(BASE / 'active.json', {'owner': 'agentcity-mumbai-active', 'runtime': str(runtime),
            'container': active['container'], 'gamePort': 25596, 'controlPort': 25597,
            'serverId': active['serverId'], 'worldUuid': config['worldUuid'], 'pluginSha256': sha(JAR),
            'artifactManifestSha256': sha(BASE / 'artifact-manifest.json')})
        return {'installed': True, 'world': WORLD, 'worldUuid': config['worldUuid'], 'backup': str(backup),
                'serverIdUnchanged': True, 'originalWorldIdsUnchanged': True}
    except Exception:
        if changed:
            current = laptop.managed.inspect_container(active['container'])
            if current and current['State']['Running']:
                laptop.run(['docker', 'stop', '--time', '90', active['container']])
            for index, path in enumerate(city_paths(runtime)):
                if not path.exists():
                    continue
                marker = path / '.agentcity-import.json'
                if marker.exists():
                    owned = load(marker).get('operation') == backup.name
                else:
                    current_ids = world_ids(runtime)
                    identity_files = [str(p.relative_to(runtime)) for p in path.glob('data/paper/metadata.dat')]
                    owned = len(identity_files) == 1 and current_ids.get(identity_files[0]) == config['worldUuid']
                require(owned, 'mumbai_rollback_refuses_unowned_world')
                path.rename(backup / ('failed-mumbai-world-' + str(index)))
            (runtime / 'plugins/AgentCity/mumbai-world.json').unlink(missing_ok=True)
            shutil.copyfile(backup / 'native/plugins/AgentCity.jar', runtime / 'plugins/AgentCity.jar')
            laptop.ACTIVE.write_bytes(original_active)
            laptop.ACTIVE.chmod(0o600)
        resume(active, running, actors)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['isolate', 'status', 'cleanup', 'install'])
    args = parser.parse_args()
    with lease():
        if args.action == 'status':
            data = load(ISOLATED)
            actual = isolated_owned(data)
            result = {'running': bool(actual and actual['State']['Running']), 'container': data['container'],
                      'worldUuid': data['worldUuid'], 'address': '127.0.0.1:25996'}
            if result['running']:
                result['native'] = native(Path(data['runtime']), 25997, 'status')
        else:
            result = {'isolate': isolate, 'cleanup': cleanup, 'install': install}[args.action]()
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ready': False, 'error': str(error)}))
        sys.exit(1)
