"""Start or inspect one owned, qualified, loopback-only non-token Minecraft host."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/maintained-world'
ACTIVE = BASE / 'active.json'
CONFIG = ROOT / 'config/minecraft-runtime.json'
SCOPE = 'Maintained loopback non-token software host; no human authentication or job acceptance claim'
COMMAND = ['java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true',
           '-Dagentcity.localConstructionResume=true', '-jar', 'paper.jar', '--nogui']


class HostError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise HostError(code)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load(path):
    return json.loads(path.read_text())


def private_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    path.chmod(0o600)


def inside(path):
    result = (ROOT / path).resolve()
    require(result.is_relative_to(ROOT), 'path_outside_project')
    return result


def execute(arguments, *, env=None, timeout=30):
    result = subprocess.run(arguments, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, 'local_command_failed')
    return result.stdout


def inspect_container(name):
    result = subprocess.run(['docker', 'inspect', name], cwd=ROOT, capture_output=True, text=True, timeout=15)
    if result.returncode:
        missing = r'(?:error(?: response from daemon)?: )?no such (?:object|container): ' + re.escape(name.lower())
        require(re.fullmatch(missing, result.stderr.strip().lower()), 'container_inspection_failed')
        return None
    values = json.loads(result.stdout)
    require(len(values) == 1, 'container_identity_ambiguous')
    return values[0]


def class_fingerprint(path):
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.endswith('.class')]
        require(names and len(names) == len(set(names)), 'invalid_application_jar')
        entries = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_manifest(directory):
    return {str(file.relative_to(directory)): sha(file) for file in sorted(directory.rglob('*')) if file.is_file()}


def configuration():
    require(CONFIG.is_file(), 'runtime_configuration_missing')
    config = load(CONFIG)
    require(config['environment'] == 'MAINTAINED_LOOPBACK_NON_TOKEN' and config['bind'] == '127.0.0.1', 'unsupported_runtime_scope')
    require(config['non_token'] is True and config['token_integration'] is False, 'non_token_scope_required')
    require(config['gamePort'] == 25596 and config['controlPort'] == 25597, 'unsupported_loopback_ports')
    require(config['client'] == '1.21.11' and config['mineflayer'] == '4.39.0' and config['pathfinder'] == '2.4.5', 'client_profile_changed')
    require(re.fullmatch(r'eclipse-temurin@sha256:[a-f0-9]{64}', config['java_image']), 'pinned_java_image_required')
    require(config['artifacts']['paper']['version'] == '26.3' and config['artifacts']['paper']['build'] == 231, 'paper_profile_changed')
    require(all(config['artifacts'][name]['version'] == '5.12.2' for name in ['ViaVersion', 'ViaBackwards']), 'via_profile_changed')
    require(sha(ROOT / 'tests/compatibility/package-lock.json') == config['dependencyLockSha256'], 'dependency_lock_changed')
    for name, expected in [('mineflayer', '4.39.0'), ('mineflayer-pathfinder', '2.4.5')]:
        require(load(ROOT / 'tests/compatibility/node_modules' / name / 'package.json')['version'] == expected, 'installed_client_changed')
    require(sha(inside(config['qualification']['report'])) == config['qualification']['reportSha256'], 'qualification_report_changed')
    return config, sha(CONFIG)


def qualification(config):
    qualification = config['qualification']
    name = qualification['runId']
    require(re.fullmatch(r'agentcity-maintained-[a-f0-9]{8}', name), 'invalid_qualification_identity')
    report_path, source = inside(qualification['report']), inside(qualification['runtime'])
    require(source == ROOT / 'tests/compatibility/maintained-candidate/.runtime' / name, 'qualification_runtime_changed')
    require(sha(report_path) == qualification['reportSha256'], 'qualification_report_changed')
    report = load(report_path)
    require(report['name'] == name and report['status'] == 'pass' and report['mode'] == 'full' and
            report['full_144_and_16_case_harness_verified'] is True and report['owned_container_removed'] is True,
            'full_qualification_required')
    require(inspect_container(name) is None, 'qualification_container_not_removed')
    for identifier in execute(['docker', 'ps', '-q']).split():
        actual = inspect_container(identifier)
        require(not any(Path(mount.get('Source', '/')).resolve() == source for mount in actual.get('Mounts', [])), 'qualification_source_in_use')
    log = report_path.parent / 'final-server.log'
    text = log.read_text()
    require(sha(log) == report['evidence_sha256']['final-server.log'] and 'All RegionFile I/O tasks to complete' in text and
            all("Halted I/O scheduler for world 'minecraft:" + dimension + "'" in text for dimension in ['overworld', 'the_nether', 'the_end']),
            'saved_qualification_world_required')
    require((source / name / 'level.dat').is_file() and (source / 'fixture-initialized').read_text() == name + '\n', 'saved_world_marker_changed')
    require(sha(source / 'plugins/AgentCity.jar') == config['application']['qualifiedJarSha256'] == report['candidate_plugin_sha256'], 'qualified_application_changed')
    require(class_fingerprint(source / 'plugins/AgentCity.jar') == config['application']['classFingerprintSha256'], 'qualified_application_classes_changed')
    for artifact, relative in [('paper', 'paper.jar'), ('ViaVersion', 'plugins/ViaVersion.jar'), ('ViaBackwards', 'plugins/ViaBackwards.jar')]:
        require(sha(source / relative) == config['artifacts'][artifact]['sha256'], 'qualified_artifact_changed')
    return source, report


def profile(config, config_sha):
    return {'schema': 'agentcity.minecraft-profile.v1', 'environment': config['environment'],
            'configSha256': config_sha, 'pluginSha256': config['application']['sha256'],
            'gamePort': config['gamePort'], 'controlPort': config['controlPort'], 'minecraft': '26.3',
            'client': '1.21.11', 'viaVersion': '5.12.2', 'viaBackwards': '5.12.2', 'javaImage': config['java_image']}


def active_metadata(config, config_sha):
    require(ACTIVE.is_file(), 'managed_host_not_created')
    data = load(ACTIVE)
    require(re.fullmatch('[a-f0-9]{32}', data['id']) and re.fullmatch('[a-f0-9]{32}', data['owner']), 'invalid_managed_identity')
    require(data['container'] == 'agentcity-maintained-host-' + data['id'][:8], 'managed_container_changed')
    require(data['configSha256'] == config_sha, 'managed_configuration_changed')
    runtime = BASE / data['id'] / 'runtime'
    require(Path(data['runtime']) == runtime and runtime.resolve().is_relative_to(BASE.resolve()), 'managed_runtime_changed')
    require(data.get('phase') != 'copying', 'managed_clone_incomplete')
    require(load(runtime / 'runtime-profile.json') == profile(config, config_sha), 'runtime_profile_changed')
    require(sha(runtime / 'plugins/AgentCity.jar') == config['application']['sha256'], 'managed_application_changed')
    for artifact, relative in [('paper', 'paper.jar'), ('ViaVersion', 'plugins/ViaVersion.jar'), ('ViaBackwards', 'plugins/ViaBackwards.jar')]:
        require(sha(runtime / relative) == config['artifacts'][artifact]['sha256'], 'managed_artifact_changed')
    require(sha(runtime / 'plugins/AgentCity/deployment.json') == data['deploymentSha256'], 'managed_job_configuration_changed')
    return data, runtime


def owned_container(data, runtime, config, *, missing=False):
    actual = inspect_container(data['container'])
    if actual is None:
        require(missing, 'managed_container_missing')
        return None
    labels = actual['Config'].get('Labels') or {}
    require(labels.get('agentcity.maintained-world') == 'true' and labels.get('agentcity.owner') == data['owner'] and
            labels.get('agentcity.config-sha256') == data['configSha256'], 'managed_container_owner_changed')
    expected = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(config['gamePort'])}],
                '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(config['controlPort'])}]}
    require(actual['HostConfig']['PortBindings'] == expected and not actual['HostConfig']['PublishAllPorts'], 'managed_port_binding_changed')
    require(actual['Config']['Image'] == config['java_image'] and actual['Config']['Cmd'] == COMMAND, 'managed_container_runtime_changed')
    mounts = actual.get('Mounts', [])
    require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Destination'] == '/server' and
            Path(mounts[0]['Source']).resolve() == runtime.resolve() and mounts[0]['RW'] is True, 'managed_mount_changed')
    if actual['State']['Running']:
        require(actual['NetworkSettings']['Ports'] == expected, 'running_port_binding_changed')
    return actual


def token_for(data):
    file = BASE / data['id'] / 'api-token'
    require(file.is_file() and file.stat().st_mode & 0o077 == 0, 'private_api_token_required')
    token = file.read_text().strip()
    require(len(token) >= 48 and not any(value.isspace() for value in token), 'invalid_private_api_token')
    return token


def http_status(config, token):
    connection = http.client.HTTPConnection('127.0.0.1', config['controlPort'], timeout=3)
    try:
        connection.request('GET', '/status', headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        body = response.read(2_000_001)
        require(response.status == 200 and len(body) <= 2_000_000, 'managed_http_unavailable')
        state = json.loads(body)['state']
        # Offline actors intentionally quarantine the job; software-host health grants no game authority.
        require(isinstance(state.get('revision'), int) and state['revision'] >= 0, 'managed_http_unhealthy')
        return state
    finally:
        connection.close()


def result(data=None, *, ready=False, error=None):
    value = {'ready': ready, 'scope': SCOPE, 'runtime': data.get('runtime') if data else None,
             'gamePort': 25596, 'controlPort': 25597}
    if data:
        value['container'] = data['container']
        value['evidence'] = data['evidence']
    if error:
        value['error'] = error
    return value


def status(config, config_sha):
    data, runtime = active_metadata(config, config_sha)
    actual = owned_container(data, runtime, config)
    require(actual['State']['Running'], 'managed_host_stopped')
    report = load(inside(data['evidence']) / 'report.json')
    check = load(inside(data['evidence']) / 'inspection-check.json')
    require(data.get('phase') == 'verified' and report['status'] == 'pass' and check['status'] == 'pass' and
            report['configSha256'] == config_sha and report['container'] == data['container'], 'initial_host_verification_pending')
    http_status(config, token_for(data))
    return result(data, ready=True)


@contextmanager
def start_lease():
    port = 30000 + int.from_bytes(hashlib.sha256(b'agentcity-maintained-world-start').digest()[:4], 'big') % 20000
    with socket.socket() as lease:
        try:
            lease.bind(('127.0.0.1', port))
            lease.listen(1)
        except OSError:
            raise HostError('managed_start_in_progress')
        yield


def free_ports(config):
    for port in [config['gamePort'], config['controlPort']]:
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                raise HostError('unknown_occupied_loopback_port')


def create_clone(config, config_sha):
    source, report = qualification(config)
    application = inside(config['application']['jar'])
    require(sha(application) == config['application']['sha256'] and
            class_fingerprint(application) == config['application']['classFingerprintSha256'], 'promoted_application_changed')
    free_ports(config)
    identifier, owner = uuid.uuid4().hex, uuid.uuid4().hex
    directory = BASE / identifier
    directory.mkdir(mode=0o700)
    runtime = directory / 'runtime'
    data = {'id': identifier, 'owner': owner, 'container': 'agentcity-maintained-host-' + identifier[:8],
            'runtime': str(runtime), 'configSha256': config_sha, 'qualificationRunId': report['name'],
            'evidence': 'evidence/runs/maintained-host/' + identifier, 'phase': 'copying',
            'createdAt': datetime.now(timezone.utc).isoformat()}
    private_json(ACTIVE, data)
    shutil.copytree(source, runtime)
    runtime.chmod(0o700)
    shutil.copyfile(application, runtime / 'plugins/AgentCity.jar')
    private_json(runtime / 'runtime-profile.json', profile(config, config_sha))
    token = secrets.token_urlsafe(48)
    descriptor = os.open(directory / 'api-token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(token + '\n')
    data.update(phase='prepared', deploymentSha256=sha(runtime / 'plugins/AgentCity/deployment.json'))
    private_json(ACTIVE, data)
    return data, runtime


def start_owned(config, config_sha):
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    BASE.chmod(0o700)
    with start_lease():
        source = inside(config['qualification']['runtime'])
        before = source_manifest(source)
        window = 'existing clone before retry/start through verification' if ACTIVE.exists() else 'before cloning through first host verification'
        measurement_started = datetime.now(timezone.utc).isoformat()
        data, runtime = active_metadata(config, config_sha) if ACTIVE.exists() else create_clone(config, config_sha)
        output = inside(data['evidence'])
        output.mkdir(parents=True, exist_ok=True)
        attempt = uuid.uuid4().hex
        (output / ('source-before-' + attempt + '.json')).write_text(json.dumps(before, sort_keys=True, indent=2) + '\n')
        token = token_for(data)
        actual = owned_container(data, runtime, config, missing=True)
        started_ms = int(time.time() * 1000)
        if actual is None:
            free_ports(config)
            execute(['docker', 'image', 'inspect', config['java_image']])
            execute(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
                     '--label', 'agentcity.maintained-world=true', '--label', 'agentcity.owner=' + data['owner'],
                     '--label', 'agentcity.config-sha256=' + config_sha,
                     '--publish', f"127.0.0.1:{config['gamePort']}:25565", '--publish', f"127.0.0.1:{config['controlPort']}:25578",
                     '--env', 'AGENTCITY_API_TOKEN', '--mount', 'type=bind,src=' + str(runtime) + ',dst=/server',
                     '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2',
                     config['java_image'], *COMMAND], env=dict(os.environ, AGENTCITY_API_TOKEN=token), timeout=60)
        elif not actual['State']['Running']:
            free_ports(config)
            execute(['docker', 'start', data['container']])
        owned_container(data, runtime, config)

        def verify_source():
            after = source_manifest(source)
            (output / ('source-after-' + attempt + '.json')).write_text(json.dumps(after, sort_keys=True, indent=2) + '\n')
            require(before == after, 'qualified_source_changed_during_verification')
            actual = owned_container(data, runtime, config)
            require(all(Path(mount['Source']).resolve() != source for mount in actual['Mounts']), 'qualified_source_mounted')
            digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            return {'sourceWasNotMounted': True, 'sourceFilesUnchangedDuringVerification': True,
                    'sourceMeasurementWindow': window, 'sourceMeasurementStartedAt': measurement_started,
                    'sourceFileCount': len(before), 'sourceManifestBeforeSha256': digest(before),
                    'sourceManifestAfterSha256': digest(after), 'sourceManifestAttemptId': attempt}
        for _ in range(180):
            try:
                http_status(config, token)
                observed = load(runtime / 'construction-observation.json')
                require(observed.get('observed_at_ms', 0) >= started_ms or data['phase'] == 'verified', 'fresh_world_observation_pending')
                break
            except (HostError, OSError, ValueError, http.client.HTTPException):
                require(owned_container(data, runtime, config)['State']['Running'], 'managed_host_stopped_during_start')
                time.sleep(1)
        else:
            raise HostError('managed_start_timeout')
        if data['phase'] != 'verified':
            require(load(runtime / 'plugins/AgentCity/deployment.json')['workDeadlineMs'] > int(time.time() * 1000), 'qualified_inspection_deadline_expired')
            environment = dict(os.environ, AGENTCITY_RESTORE_RUNTIME=str(runtime), AGENTCITY_API_TOKEN=token,
                               AGENTCITY_RESTORE_STARTED_MS=str(started_ms), AGENTCITY_RESTORE_GAME_PORT=str(config['gamePort']),
                               AGENTCITY_RESTORE_CONTROL_PORT=str(config['controlPort']), AGENTCITY_MINECRAFT_PROFILE='maintained')
            checked = subprocess.run(['node', 'ops/inspect_restored_world.cjs'], cwd=ROOT, env=environment,
                                     capture_output=True, text=True, timeout=360)
            check_path = runtime / 'restore-check.json'
            if check_path.exists():
                check = load(check_path)
                (output / 'inspection-check.json').write_text(json.dumps(check, indent=2).replace(token, '<redacted>') + '\n')
            require(checked.returncode == 0 and check_path.exists(), 'managed_inspection_failed')
            inspection = check.get('inspection') or {}
            require(check['status'] == 'pass' and inspection.get('status') == 'PASS' and len(inspection.get('rows', [])) == 16 and
                    all(row['observed'] == row['expected'] for row in inspection['rows']), 'fresh_sixteen_case_inspection_required')
            qualification_report = load(inside(config['qualification']['report']))
            require(inspection['runId'] != qualification_report['inspection_run_id'], 'new_host_inspection_required')
            public = {**result(data, ready=True), 'status': 'pass', 'configSha256': config_sha,
                      'qualificationRunId': data['qualificationRunId'], **verify_source(),
                      'resumeWithoutBootstrap': True, 'pluginSha256': config['application']['sha256'],
                      'inspectionRunId': inspection['runId'], 'independentHumans': 0, 'realSpendUsd': 0,
                      'verifiedAt': datetime.now(timezone.utc).isoformat()}
            (output / 'report.json').write_text(json.dumps(public, indent=2) + '\n')
            (output / 'public-metadata.json').write_text(json.dumps(profile(config, config_sha), indent=2) + '\n')
            data['phase'] = 'verified'
            private_json(ACTIVE, data)
        else:
            (output / ('reuse-check-' + attempt + '.json')).write_text(json.dumps({
                'status': 'pass', 'container': data['container'], 'containerId': owned_container(data, runtime, config)['Id'],
                'runtime': str(runtime), 'reinspection': False, **verify_source()}, indent=2) + '\n')
        return status(config, config_sha)


def start(config, config_sha):
    try:
        return start_owned(config, config_sha)
    except Exception as error:
        # Preserve failed attempts without replacing any successful qualification or host record.
        if ACTIVE.is_file():
            data = load(ACTIVE)
            if re.fullmatch('[a-f0-9]{32}', data.get('id', '')):
                output = ROOT / 'evidence/runs/maintained-host' / data['id']
                output.mkdir(parents=True, exist_ok=True)
                failure = {'status': 'fail', 'scope': SCOPE, 'error': str(error) if isinstance(error, HostError) else 'managed_host_operation_failed',
                           'configSha256': config_sha, 'recordedAt': datetime.now(timezone.utc).isoformat()}
                (output / ('attempt-' + uuid.uuid4().hex + '.json')).write_text(json.dumps(failure, indent=2) + '\n')
                if not (output / 'report.json').exists():
                    (output / 'report.json').write_text(json.dumps(failure, indent=2) + '\n')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status'])
    arguments = parser.parse_args()
    try:
        settings, digest = configuration()
        answer = start(settings, digest) if arguments.action == 'start' else status(settings, digest)
    except HostError as error:
        answer = result(error=str(error))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, http.client.HTTPException, zipfile.BadZipFile):
        answer = result(error='managed_host_operation_failed')
    print(json.dumps(answer))
    sys.exit(0 if answer['ready'] else 1)
