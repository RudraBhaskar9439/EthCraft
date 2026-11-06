"""Run a bounded subset of real Paper boundary tests; never approve a phase."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
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

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'tests/inspection'
GAME_PORT = 25581
HTTP_PORT = 25578


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


p0 = module('inspection_p0_runtime', ROOT / 'tests/compatibility/run.py')
builder = module('inspection_plugin_build', HERE / 'build.py')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def offline_uuid(name):
    digest = bytearray(hashlib.md5(('OfflinePlayer:' + name).encode()).digest())
    digest[6] = digest[6] & 15 | 48
    digest[8] = digest[8] & 63 | 128
    return str(uuid.UUID(bytes=bytes(digest)))


def redact(text, token):
    text = text.replace(token, '<redacted-api-credential>') if token else text
    return re.sub(r'AC_SESSION\s+[0-9a-fA-F-]{36}\s+\S+', 'AC_SESSION <redacted>', text)


def owns_container(actual, expected):
    return bool(re.fullmatch(r'[a-f0-9]{32}', expected)) and actual == expected


def cleanup_owned(name, owner, evidence, label):
    found = p0.command(['docker', 'inspect', '--format', '{{index .Config.Labels "agentcity.inspection.owner"}}', name], timeout=15, check=False)
    if found.returncode and any(message in found.stderr.lower() for message in ['no such container', 'no such object']):
        return [], True
    if found.returncode or not owns_container(found.stdout.strip(), owner):
        return ['Refused cleanup: exact container ownership label was not established.'], False
    return p0.cleanup_container(name, evidence, label)


def deployment(run_id, blueprint, tests, deadline):
    return {
        'serverId': 'local-inspection-server', 'jobId': run_id, 'agreementVersion': 1,
        'authorizationReference': 'local-boundary-authorization', 'world': run_id,
        'plotMin': [-16, 80, -8], 'plotMax': [15, 95, 7], 'chest': [-14, 81, 5],
        'actors': {offline_uuid(name): role for name, role in [
            ('WorldBuilder', 'BOT'), ('WorldRequester', 'REQUESTER'), ('WorldInspector', 'INSPECTOR')]},
        'blueprintSha256': sha(blueprint), 'testManifestSha256': sha(tests),
        'workDeadlineMs': deadline, 'reviewDeadlineMs': deadline + 900000,
        'obligationMode': 'LOCAL_NO_EXTERNAL_OBLIGATIONS', 'localPassValidityMs': 30000,
    }


def self_check():
    assert offline_uuid('WorldBuilder') == str(uuid.UUID(offline_uuid('WorldBuilder')))
    assert offline_uuid('WorldBuilder') != offline_uuid('WorldRequester')
    value = 'secret123 AC_SESSION 12345678-1234-1234-1234-123456789abc session-secret'
    cleaned = redact(value, 'secret123')
    assert 'secret123' not in cleaned and 'session-secret' not in cleaned
    assert [GAME_PORT, HTTP_PORT] == [25581, 25578]
    assert GAME_PORT != HTTP_PORT
    assert owns_container('a' * 32, 'a' * 32) and not owns_container('b' * 32, 'a' * 32)
    assert not owns_container('', '')
    print('PASS: offline fixture identity, credential redaction and fixed isolated ports')


def run(blueprint, tests, suite, restart):
    lock = json.loads((ROOT / 'tests/compatibility/versions.json').read_text())
    p0.validate_versions(lock)
    run_id = 'agentcity-boundary-' + uuid.uuid4().hex[:8]
    runtime = ROOT / '.local/inspection/runs' / run_id
    evidence = ROOT / 'evidence/runs/p1-boundary' / run_id
    runtime.mkdir(parents=True)
    evidence.mkdir(parents=True)
    token = secrets.token_urlsafe(48)
    owner = uuid.uuid4().hex
    attempted = False
    result = {
        'schema': 'agentcity.p1.boundary-run.v1', 'name': run_id, 'status': 'fail',
        'started_at': datetime.now(timezone.utc).isoformat(), 'suite': suite,
        'purpose': 'actual local Paper boundary subset; no complete phase claim',
        'ports': {'game': GAME_PORT, 'control_http': HTTP_PORT, 'host': '127.0.0.1'},
        'restart_requested': restart,
        'independent_humans': 0, 'full_phase_gate_passed': False,
        'injected_resources': 'Operator-seeded 143 circuit placements, exact full job stock bill, external north access stairs/platform, requester personal water/lava buckets, stranger personal cobblestone; no token backing or bot-build claim.',
        'runtime_lock': lock, 'steps': [],
    }
    try:
        for port in [GAME_PORT, HTTP_PORT]:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        p0.command(['python3', 'scripts/check_phase.py', 'P0'], timeout=30, log_path=evidence / 'prerequisite-gate.log')
        b, t = json.loads(blueprint.read_text()), json.loads(tests.read_text())
        if b.get('status') != 'physically_validated' or b.get('usable_for_funded_agreement') is not False or b.get('full_phase_acceptance') is not False:
            raise ValueError('Requires the explicitly non-funded physical selection blueprint, not a claimed P1 pass.')
        if t.get('blueprint_sha256') != sha(blueprint) or not t.get('timing_calibrated'):
            raise ValueError('Test/blueprint binding is missing or changed.')
        target = next(p for p in b['placements'] if p['position'] == [10, 1, 0])
        if target['block'] != 'minecraft:redstone_wire':
            raise ValueError('Native placement target must remain the declared supported low redstone-wire position.')
        sources = sorted([*list((ROOT / 'plugin').rglob('*')), *list(HERE.rglob('*')),
                          blueprint, tests, ROOT / 'tests/compatibility/versions.json',
                          ROOT / 'tests/compatibility/package-lock.json', ROOT / 'config/p0-policy.json'])
        sources = [p for p in sources if p.is_file() and '__pycache__' not in p.parts]
        before = {str(p.relative_to(ROOT)): sha(p) for p in sources}
        for p in sources:
            copy = evidence / 'source' / p.relative_to(ROOT)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, copy)
        result['sources'] = before
        print(f'{run_id}: compiling exact current main plugin and isolated fixture', flush=True)
        artifact, _, _ = builder.build()
        if any(sha(ROOT / path) != digest for path, digest in before.items()):
            raise RuntimeError('Sources changed during compilation; retain this attempt and rerun a frozen source set.')
        frozen_blueprint = evidence / 'source' / blueprint.relative_to(ROOT)
        frozen_tests = evidence / 'source' / tests.relative_to(ROOT)
        for log in ['compile.log', 'compile-checks.log', 'package.log']:
            if (ROOT / '.local/inspection' / log).exists():
                shutil.copyfile(ROOT / '.local/inspection' / log, evidence / log)
        cache = ROOT / '.local/compatibility/server'
        if sha(cache / 'paper.jar') != lock['paper']['sha256']:
            raise ValueError('Cached Paper checksum differs from the reviewed pinned artifact.')
        for directory in ['libraries', 'versions', 'cache']:
            shutil.copytree(cache / directory, runtime / directory)
        shutil.copyfile(cache / 'paper.jar', runtime / 'paper.jar')
        (runtime / 'plugins/AgentCity').mkdir(parents=True)
        shutil.copyfile(artifact, runtime / 'plugins/AgentCity.jar')
        shutil.copyfile(frozen_blueprint, runtime / 'plugins/AgentCity/blueprint.json')
        shutil.copyfile(frozen_tests, runtime / 'plugins/AgentCity/tests.json')
        deadline = int(time.time() * 1000) + 3600000
        config = deployment(run_id, frozen_blueprint, frozen_tests, deadline)
        config_bytes = (json.dumps(config, indent=2) + '\n').encode()
        data = runtime / 'plugins/AgentCity'
        (data / 'deployment.json').write_bytes(config_bytes)
        (data / 'bootstrap-grant').write_text(run_id + '\n' + hashlib.sha256(config_bytes).hexdigest() + '\n')
        (evidence / 'deployment.json').write_bytes(config_bytes)
        plan = {'schema': 'agentcity.boundary-fixture.v1', 'purpose': 'isolated_non_token_p1_boundary',
                'run_id': run_id, 'world': run_id, 'placement_target': [-2, 82, -4],
                'placement_support': [-2, 81, -4], 'placement_item': 'minecraft:redstone',
                'placement_state': 'minecraft:redstone_wire', 'stock': b['material_bill'],
                'deployment': config, 'blueprint': b, 'test_manifest': t, 'suite': suite,
                'allowed_mode_faults': ['creative_begin', 'creative_end'],
                'external_access': {'outside_plot_z': [-10, -9], 'ramp_x': [-14, -4], 'step_height': 0.5, 'platform_x': [-4, 1], 'platform_feet_y': 86, 'operator_fixture_not_job_materials': True, 'edge_stance_z': [-8.03, -7.7]},
                'post_bootstrap_world_or_inventory_edit_api': False}
        (runtime / 'boundary-fixture.json').write_text(json.dumps(plan, indent=2) + '\n')
        (evidence / 'fixture-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
        classes = runtime / 'fixture-classes'
        classes.mkdir()
        cp = ':'.join('/server/' + str(p.relative_to(runtime)) for p in sorted([*runtime.glob('libraries/**/*.jar'), *runtime.glob('versions/**/*.jar')]))
        base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
                '--mount', f'type=bind,src={runtime},dst=/server',
                '--mount', f'type=bind,src={evidence / "source/tests/inspection/fixture"},dst=/source,readonly', lock['java_image']]
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/server/fixture-classes', '/source/WorldFixture.java'], timeout=60, log_path=evidence / 'compile-fixture.log')
        shutil.copyfile(evidence / 'source/tests/inspection/fixture/plugin.yml', classes / 'plugin.yml')
        (runtime / 'fixture-manifest.mf').write_text('Manifest-Version: 1.0\npaperweight-mappings-namespace: mojang\n\n')
        p0.command(base + ['jar', '--create', '--manifest', '/server/fixture-manifest.mf', '--file', '/server/plugins/AgentCityWorldFixture.jar', '-C', '/server/fixture-classes', '.'], timeout=30, log_path=evidence / 'package-fixture.log')
        result['plugin_sha256'] = sha(runtime / 'plugins/AgentCity.jar')
        result['fixture_plugin_sha256'] = sha(runtime / 'plugins/AgentCityWorldFixture.jar')
        (runtime / 'eula.txt').write_text('# Owner-authorized isolated local engineering fixture.\neula=true\n')
        properties = p0.server_properties().replace('level-name=compatibility-world', 'level-name=' + run_id).replace('max-players=3', 'max-players=4')
        (runtime / 'server.properties').write_text(properties)

        def start(label):
            nonlocal attempted
            print(f'{run_id}: {label} starting pinned Paper on loopback only', flush=True)
            attempted = True
            env = dict(os.environ, AGENTCITY_API_TOKEN=token)
            p0.command(['docker', 'run', '--detach', '--name', run_id, '--label', 'agentcity.inspection.boundary=true', '--label', f'agentcity.inspection.owner={owner}',
                        '--publish', f'127.0.0.1:{GAME_PORT}:25565', '--publish', f'127.0.0.1:{HTTP_PORT}:25578',
                        '--env', 'AGENTCITY_API_TOKEN', '--mount', f'type=bind,src={runtime},dst=/server',
                        '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2',
                        lock['java_image'], 'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-jar', 'paper.jar', '--nogui'],
                       timeout=90, env=env, log_path=evidence / f'{label}-start.log')
            until = time.monotonic() + 180
            while time.monotonic() < until:
                logs = p0.command(['docker', 'logs', run_id], timeout=10, check=False)
                (evidence / f'{label}-server.log').write_text(redact(logs.stdout + logs.stderr, token))
                state = p0.command(['docker', 'inspect', '--format', '{{.State.Running}}', run_id], timeout=10, check=False)
                if state.stdout.strip() != 'true':
                    raise RuntimeError('Paper stopped during ' + label + ': ' + redact((logs.stdout + logs.stderr)[-2500:], token))
                if 'Done (' in logs.stdout + logs.stderr:
                    return
                time.sleep(1)
            raise TimeoutError('Pinned Paper startup exceeded 180 seconds.')

        def stop(label):
            nonlocal attempted
            errors, removed = cleanup_owned(run_id, owner, evidence, label)
            attempted = not removed
            if errors or not removed:
                raise RuntimeError('Owned container cleanup failed: ' + str(errors))

        def probe(phase):
            print(f'{run_id}: real clients executing {phase} subset', flush=True)
            env = dict(os.environ, AC_BOUNDARY_TOKEN=token, AC_BOUNDARY_RUNTIME=str(runtime),
                       AC_BOUNDARY_REPORT=str(evidence / f'{phase}-client.json'), AC_BOUNDARY_PHASE=phase,
                       AC_BOUNDARY_SUITE=suite, AC_BOUNDARY_GAME_PORT=str(GAME_PORT), AC_BOUNDARY_HTTP_PORT=str(HTTP_PORT),
                       AC_BOUNDARY_DEPENDENCY_ROOT=str(ROOT / 'tests/compatibility/node_modules'))
            with (evidence / f'{phase}-client.log').open('w') as output:
                process = subprocess.run(['node', str(evidence / 'source/tests/inspection/probe.cjs')], cwd=ROOT, env=env, text=True, stdout=output, stderr=subprocess.STDOUT,
                                         timeout=630 if suite == 'lifecycle' else 360 if suite != 'primitives' else 180)
            if process.returncode:
                raise RuntimeError(f'Node {phase} subset failed; see retained {phase}-client.json/log.')
            observed = json.loads((evidence / f'{phase}-client.json').read_text())
            if observed.get('status') != 'pass':
                raise RuntimeError('Physical boundary probe did not pass its declared subset.')
            result['steps'].append({'phase': phase, 'status': 'pass', 'assertion_groups': len(observed['steps'])})

        start('initial')
        probe('initial')
        if restart:
            stop('restart-stop')
            start('restart')
            probe('restart')
        result['status'] = 'pass'
    except Exception as error:
        result['error'] = redact(str(error), token)
        raise
    finally:
        if attempted:
            errors, removed = cleanup_owned(run_id, owner, evidence, 'final-server')
            if errors or not removed:
                result['status'] = 'fail'
                result['cleanup_errors'] = errors or ['Owned container removal was not established.']
        for source in ['boundary-observation.json', 'boundary-events.jsonl', 'boundary-probe-state.json',
                       'fixture-initialized', 'plugins/AgentCity/operations.journal', 'plugins/AgentCity/initialized-job']:
            origin = runtime / source
            if origin.exists():
                destination = evidence / 'retained' / source
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(origin, destination)
        if (runtime / 'plugins/AgentCity/reports').exists():
            shutil.copytree(runtime / 'plugins/AgentCity/reports', evidence / 'retained/reports')
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        changed = [path for path, digest in result.get('sources', {}).items() if not (ROOT / path).is_file() or sha(ROOT / path) != digest]
        if changed:
            result['status'] = 'fail'
            result['source_integrity_changed_during_attempt'] = changed
        for file in evidence.rglob('*'):
            if file.is_file() and file.suffix in {'.log', '.json', '.jsonl', '.txt'}:
                try:
                    value = file.read_text()
                    cleaned = redact(value, token)
                    if cleaned != value:
                        file.write_text(cleaned)
                except UnicodeError:
                    pass
        result['retained_artifacts'] = {str(p.relative_to(evidence)): sha(p) for p in evidence.rglob('*') if p.is_file()}
        (evidence / 'run-report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'evidence': str(evidence.relative_to(ROOT)), 'error': result.get('error')}), flush=True)
    if result['status'] != 'pass':
        raise RuntimeError('Boundary fixture cleanup or retention failed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blueprint', type=Path, default=ROOT / 'fixtures/blueprints/calculator-v1.json')
    parser.add_argument('--tests', type=Path, default=ROOT / 'fixtures/test-manifests/calculator-v1.json')
    parser.add_argument('--suite', choices=['access', 'primitives', 'inspection', 'lifecycle'], default='primitives')
    parser.add_argument('--no-restart', action='store_true', help='Explicit exploratory subset; does not verify restart replay.')
    parser.add_argument('--self-check', action='store_true')
    args = parser.parse_args()
    if args.no_restart and args.suite not in ['access', 'primitives']:
        parser.error('Inspection/lifecycle suites require the same-configuration restart stage.')
    if args.self_check:
        self_check()
    else:
        run(args.blueprint.resolve(), args.tests.resolve(), args.suite, not args.no_restart and args.suite != 'access')
