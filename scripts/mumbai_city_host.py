"""Qualify and upgrade UniRock on the existing owned Mumbai world without importing another city."""
import argparse
from contextlib import contextmanager
import fcntl
import importlib.util
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('mumbai_city_base', ROOT / 'scripts/mumbai_host.py')
mumbai = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mumbai)
BASE = ROOT / '.local/mumbai-city'
ISOLATED = BASE / 'isolated-active.json'
MARKER = BASE / 'isolated-verification.json'
JAR = ROOT / '.local/plugin-build/AgentCity.jar'
OWNER = 'agentcity-mumbai-city-isolated'
laptop, ops = mumbai.laptop, mumbai.ops
load, sha, write, require = mumbai.load, mumbai.sha, mumbai.write, mumbai.require


@contextmanager
def lease():
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    BASE.chmod(0o700)
    with (BASE / 'host.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('mumbai_city_host_operation_already_running') from error
        yield


def inputs():
    require(JAR.is_file() and not JAR.is_symlink(), 'mumbai_city_candidate_jar_required')
    active = load(laptop.ACTIVE)
    actual = laptop.owned(active)
    runtime = Path(active['runtime'])
    config_file = runtime / 'plugins/AgentCity/mumbai-world.json'
    require(config_file.is_file() and not config_file.is_symlink(), 'mumbai_city_existing_configuration_required')
    config = load(config_file)
    require(config.get('schema') == 'agentcity.mumbai-world.v1' and config.get('world') == mumbai.WORLD,
            'mumbai_city_existing_world_required')
    ids = mumbai.world_ids(runtime)
    require(len(ids) == 7 and len(set(ids.values())) == 7 and config.get('worldUuid') in ids.values(),
            'mumbai_city_seven_existing_world_ids_required')
    return active, actual, runtime, config, ids


def isolated_owned(data):
    identifier = data.get('id', '')
    require(data.get('owner') == OWNER and len(identifier) == 32
            and set(identifier) <= set('0123456789abcdef'), 'mumbai_city_isolation_owner_changed')
    require(data.get('container') == 'agentcity-mumbai-city-' + identifier[:8], 'mumbai_city_container_name_changed')
    runtime = Path(data['runtime'])
    require(runtime == BASE / 'isolated' / identifier and not runtime.is_symlink()
            and runtime.resolve().is_relative_to((BASE / 'isolated').resolve()), 'mumbai_city_isolation_path_changed')
    require(sha(runtime / 'plugins/AgentCity.jar') == data['pluginSha256'], 'mumbai_city_isolation_plugin_changed')
    actual = laptop.managed.inspect_container(data['container'])
    if actual is None:
        return None
    labels = actual['Config'].get('Labels') or {}
    bindings = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25996'}],
                '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25997'}]}
    mounts = actual['Mounts']
    require(labels.get('agentcity.owner') == OWNER and labels.get('agentcity.mumbai-city') == identifier
            and actual['HostConfig']['PortBindings'] == bindings and actual['Config']['Image'] == data['javaImage']
            and len(mounts) == 1 and mounts[0]['Destination'] == '/server'
            and Path(mounts[0]['Source']).resolve() == runtime.resolve(), 'mumbai_city_isolation_profile_changed')
    return actual


def ready(runtime, port, config, server_id, container):
    until = time.monotonic() + 180
    while time.monotonic() < until:
        record = load(ISOLATED if port == 25997 else laptop.ACTIVE)
        require(record['container'] == container, 'mumbai_city_readiness_container_changed')
        actual = isolated_owned(record) if port == 25997 else laptop.owned(record)
        require(actual is not None and actual['State']['Running'], 'mumbai_city_owned_candidate_exited')
        try:
            state = mumbai.native(runtime, port, 'status')
            properties = mumbai.native(runtime, port, 'property/status', {})
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            time.sleep(1)
            continue
        value = state.get('mumbai') or {}
        if state.get('available') is True and value.get('ready') is True:
            require(value.get('world') == mumbai.WORLD and value.get('worldUuid') == config['worldUuid']
                    and properties.get('serverNamespace') == server_id, 'mumbai_city_loaded_world_binding_changed')
            bank = value.get('bank') or {}
            require(bank.get('ready') is True and bank.get('name') == 'UniRock'
                    and bank.get('stockGranted') == 0, 'mumbai_city_bank_not_ready')
            return state
        time.sleep(1)
    raise RuntimeError('mumbai_city_native_startup_not_ready')


def isolate():
    active, actual, source, config, ids = inputs()
    if ISOLATED.exists():
        previous = load(ISOLATED)
        require(isolated_owned(previous) is None and previous.get('cleaned') is True,
                'mumbai_city_existing_isolation_requires_cleanup')
    for port in (25996, 25997):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    identifier = uuid.uuid4().hex
    runtime = BASE / 'isolated' / identifier
    runtime.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    active_sha = sha(laptop.ACTIVE)
    config_sha = sha(source / 'plugins/AgentCity/mumbai-world.json')
    running, actors = actual['State']['Running'], mumbai.actor_running(active)
    try:
        mumbai.quiesce(active, actual)
        require(sha(laptop.ACTIVE) == active_sha and mumbai.world_ids(source) == ids,
                'mumbai_city_source_changed_during_quiesce')
        shutil.copytree(source, runtime, ignore=shutil.ignore_patterns('logs', 'crash-reports', 'session.lock'))
        runtime.chmod(0o700)
        require(mumbai.world_ids(runtime) == ids == mumbai.world_ids(source), 'mumbai_city_clone_world_ids_changed')
    finally:
        mumbai.resume(active, running, actors)
    token = secrets.token_urlsafe(48)
    (runtime / 'api-token').write_text(token + '\n')
    (runtime / 'api-token').chmod(0o600)
    properties = runtime / 'server.properties'
    controls = {'enable-rcon': 'true', 'rcon.port': '25575', 'rcon.password': secrets.token_urlsafe(32), 'broadcast-rcon-to-ops': 'false'}
    properties.write_text('\n'.join(line for line in properties.read_text().splitlines() if line.split('=', 1)[0] not in controls)
                          + '\n' + '\n'.join(key + '=' + value for key, value in controls.items()) + '\n')
    properties.chmod(0o600)
    shutil.copyfile(JAR, runtime / 'plugins/AgentCity.jar')
    data = {'owner': OWNER, 'id': identifier, 'runtime': str(runtime),
            'container': 'agentcity-mumbai-city-' + identifier[:8], 'javaImage': active['javaImage'],
            'serverId': active['serverId'], 'worldUuid': config['worldUuid'], 'sourceContainer': active['container'],
            'sourceActiveSha256': active_sha, 'sourceMumbaiConfigSha256': config_sha, 'sourceWorldIds': ids,
            'pluginSha256': sha(JAR), 'gamePort': 25996, 'controlPort': 25997}
    write(ISOLATED, data)
    laptop.run(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
        '--label', 'agentcity.owner=' + OWNER, '--label', 'agentcity.mumbai-city=' + identifier,
        '--publish', '127.0.0.1:25996:25565', '--publish', '127.0.0.1:25997:25578', '--env', 'AGENTCITY_API_TOKEN',
        '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
        '--memory', '2g', '--cpus', '2', data['javaImage'], 'java', '-Xms512M', '-Xmx1536M',
        '-Dagentcity.localFixture=true', '-Dagentcity.playable=true', '-Dagentcity.worldAssets=true',
        '-Dagentcity.discordRequired=true', '-jar', 'paper.jar', '--nogui'], env=dict(os.environ, AGENTCITY_API_TOKEN=token))
    isolated_owned(data)
    ready(runtime, 25997, config, active['serverId'], data['container'])
    require(mumbai.world_ids(runtime) == ids, 'mumbai_city_isolated_world_ids_changed')
    return {'ready': True, 'container': data['container'], 'address': '127.0.0.1:25996',
            'sourceUnchanged': sha(laptop.ACTIVE) == active_sha, 'existingWorldsPreserved': True}


def qualification():
    proof, isolated = load(MARKER), load(ISOLATED)
    expected = {key: isolated[key] for key in ('pluginSha256', 'serverId', 'worldUuid', 'sourceActiveSha256',
                                              'sourceMumbaiConfigSha256', 'sourceWorldIds')}
    expected['isolatedId'] = isolated['id']
    require(proof.get('owner') == 'agentcity-mumbai-city-isolated-proof' and proof.get('status') == 'pass'
            and all(proof.get(key) == value for key, value in expected.items())
            and proof.get('pluginSha256') == sha(JAR), 'mumbai_city_matching_isolated_verification_required')
    report = (ROOT / proof['report']).resolve()
    require(report.is_relative_to((ROOT / 'evidence/runs').resolve()) and report.is_file()
            and sha(report) == proof['reportSha256'], 'mumbai_city_actual_isolated_report_required')
    observed = load(report)
    require(observed.get('status') == 'pass' and observed.get('isolatedId') == isolated['id']
            and observed.get('pluginSha256') == isolated['pluginSha256']
            and observed.get('serverId') == isolated['serverId']
            and observed.get('worldIds') == isolated['sourceWorldIds'], 'mumbai_city_report_binding_changed')
    return isolated


def upgrade():
    isolated = qualification()
    active, actual, runtime, config, ids = inputs()
    require(sha(laptop.ACTIVE) == isolated['sourceActiveSha256'] and ids == isolated['sourceWorldIds']
            and sha(runtime / 'plugins/AgentCity/mumbai-world.json') == isolated['sourceMumbaiConfigSha256'],
            'mumbai_city_active_profile_changed_since_qualification')
    backup = BASE / 'backups' / uuid.uuid4().hex
    backup.mkdir(parents=True, mode=0o700)
    original_active = laptop.ACTIVE.read_bytes()
    running, actors = actual['State']['Running'], mumbai.actor_running(active)
    changed = False
    try:
        mumbai.quiesce(active, actual)
        require(mumbai.world_ids(runtime) == ids, 'mumbai_city_world_ids_changed_during_quiesce')
        # Complete private native files are preserved; the chain and database are never rolled back automatically.
        shutil.copytree(runtime, backup / 'native')
        (backup / 'native').chmod(0o700)
        (backup / 'active.json').write_bytes(original_active)
        (backup / 'active.json').chmod(0o600)
        database = ops.backup()
        write(backup / 'rollback.json', {'sourceContainer': active['container'], 'serverId': active['serverId'],
            'worldIds': ids, 'databaseBackup': str(database), 'oldPluginSha256': active['pluginSha256'],
            'newPluginSha256': sha(JAR), 'worldUuid': config['worldUuid']})
        changed = True
        shutil.copyfile(JAR, runtime / 'plugins/AgentCity.jar')
        updated = {**active, 'pluginSha256': sha(JAR)}
        write(laptop.ACTIVE, updated)
        if running:
            laptop.ports_free()
            laptop.run(['docker', 'start', active['container']])
            ready(runtime, 25597, config, active['serverId'], active['container'])
        require(mumbai.world_ids(runtime) == ids
                and sha(runtime / 'plugins/AgentCity/mumbai-world.json') == isolated['sourceMumbaiConfigSha256'],
                'mumbai_city_upgrade_world_or_configuration_changed')
        if running and actors:
            laptop.actors(updated)
        record = {'owner': 'agentcity-mumbai-city-active', 'status': 'upgraded', 'backup': str(backup),
                  'runtime': str(runtime), 'container': active['container'], 'serverId': active['serverId'],
                  'worldUuid': config['worldUuid'], 'worldIds': ids, 'pluginSha256': updated['pluginSha256'],
                  'gamePort': 25596, 'controlPort': 25597, 'isolatedId': isolated['id']}
        write(BASE / 'active.json', record)
        return {'upgraded': True, 'running': running, 'backup': str(backup),
                'serverNamespaceUnchanged': True, 'allSevenWorldIdsUnchanged': True}
    except Exception as error:
        bank_records = [Path('plugins/AgentCity') / name for name in
                        ('unirock-bank.json', 'unirock-bank-migration-v1-v2.json')]
        marker_changed = changed and any(
            ((backup / 'native' / path).read_bytes() if (backup / 'native' / path).is_file() else None)
            != ((runtime / path).read_bytes() if (runtime / path).is_file() else None)
            for path in bank_records)
        write(backup / 'failure.json', {'status': 'failed', 'exception': type(error).__name__,
                                      'pluginChanged': changed, 'databaseAndWorldNotRolledBack': True,
                                      'bankMarkerChanged': marker_changed, 'recoveryRequired': marker_changed})
        if changed:
            current = laptop.managed.inspect_container(active['container'])
            require(current is not None and current['Id'] == actual['Id'], 'mumbai_city_rollback_container_changed')
            if current['State']['Running']:
                laptop.run(['docker', 'stop', '--time', '90', active['container']])
            shutil.copyfile(runtime / 'plugins/AgentCity.jar', backup / 'failed-AgentCity.jar')
            # An older plugin cannot read a migrated bank; retain the qualified candidate and stop for forward recovery.
            if marker_changed:
                write(laptop.ACTIVE, {**updated, 'recoveryRequired': True, 'recoveryBackup': str(backup)})
                raise RuntimeError('mumbai_city_forward_recovery_required_candidate_retained_' + str(backup)) from error
            shutil.copyfile(backup / 'native/plugins/AgentCity.jar', runtime / 'plugins/AgentCity.jar')
            laptop.ACTIVE.write_bytes(original_active)
            laptop.ACTIVE.chmod(0o600)
        mumbai.resume(active, running, actors)
        raise


def cleanup():
    data = load(ISOLATED)
    actual = isolated_owned(data)
    if actual:
        if actual['State']['Running']:
            laptop.run(['docker', 'stop', '--time', '90', data['container']])
        laptop.run(['docker', 'rm', data['container']])
    data['cleaned'] = True
    write(ISOLATED, data)
    return {'removedOwnedContainer': True, 'privateRuntimeRetained': data['runtime']}


def status():
    data = load(ISOLATED)
    actual = isolated_owned(data)
    result = {'running': bool(actual and actual['State']['Running']), 'container': data['container'],
              'worldUuid': data['worldUuid'], 'address': '127.0.0.1:25996'}
    if result['running']:
        state = mumbai.native(Path(data['runtime']), 25997, 'status')
        result['city'] = state.get('mumbai')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['isolate', 'upgrade', 'status', 'cleanup'])
    args = parser.parse_args()
    with lease():
        print(json.dumps({'isolate': isolate, 'upgrade': upgrade, 'status': status, 'cleanup': cleanup}[args.action]()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ready': False, 'error': str(error)}))
        sys.exit(1)
