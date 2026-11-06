"""Isolated sealed negative probes against the real protected Paper checker."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fault_boundary_helpers', ROOT / 'tests/inspection/run.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
spec = importlib.util.spec_from_file_location('sealed_fault_augmentation', HERE / 'augment.py')
augment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(augment)
p0 = boundary.p0
sha = boundary.sha
SCENARIOS = ['missing-lamp-s0-preflight', 'wrong-input-a0-preflight', 'missing-input-support-a0-preflight'] + [
    kind + '-' + window for kind in ['missing-lamp-s0', 'wrong-input-a0', 'missing-input-support-a0', 'adapter-unavailable', 'unloaded-chunk-s1']
    for window in ['input_setting', 'lamp_measurement']]
GAME_PORT, HTTP_PORT = 25583, 25582


def variant_ids(scenario):
    if scenario == 'missing-lamp-s0-preflight':
        return ['P1-004/output-missing-s0']
    if scenario == 'wrong-input-a0-preflight':
        return ['P1-004/input-wrong_block_type-a0']
    if scenario.startswith(('missing-lamp-s0-', 'missing-input-support-a0-', 'adapter-unavailable-', 'unloaded-chunk-s1-')) and not scenario.endswith('preflight'):
        return ['P1-006/' + scenario]
    return []


def run(scenario, restart=True):
    if scenario not in SCENARIOS:
        raise ValueError('Unknown sealed scenario; no arbitrary targets or actions are accepted.')
    lock = json.loads((ROOT / 'tests/compatibility/versions.json').read_text())
    p0.validate_versions(lock)
    name = 'agentcity-fault-' + uuid.uuid4().hex[:8]
    runtime = ROOT / '.local/inspection/faults' / name
    evidence = ROOT / 'evidence/runs/p1-faults' / name
    runtime.mkdir(parents=True)
    evidence.mkdir(parents=True)
    token, owner = secrets.token_urlsafe(48), uuid.uuid4().hex
    attempted = False
    result = {'schema': 'agentcity.p1.fault-run.v1', 'status': 'fail', 'name': name, 'scenario': scenario,
              'started_at': datetime.now(timezone.utc).isoformat(), 'restart_requested': restart,
              'ports': {'host': '127.0.0.1', 'game': GAME_PORT, 'control': HTTP_PORT, 'container_control': 25578},
              'purpose': 'Actual protected-checker negative subset, not a complete phase gate.',
              'full_phase_gate_passed': False, 'independent_humans': 0,
              'candidate_variant_ids_only_until_observed': variant_ids(scenario), 'runtime_lock': lock,
              'steps': [], 'source_scope': 'Production plugin compiled read-only; existing boundary fixture augmented in an isolated generated copy only.'}
    try:
        for port in [GAME_PORT, HTTP_PORT]:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('127.0.0.1', port))
        p0.command(['python3', 'scripts/check_phase.py', 'P0'], timeout=30, log_path=evidence / 'prerequisite-gate.log')
        blueprint = ROOT / 'fixtures/blueprints/calculator-v1.json'
        tests = ROOT / 'fixtures/test-manifests/calculator-v1.json'
        b, t = json.loads(blueprint.read_text()), json.loads(tests.read_text())
        if b.get('status') != 'physically_validated' or b.get('usable_for_funded_agreement') is not False or b.get('full_phase_acceptance') is not False:
            raise ValueError('Explicit non-funded, non-phase-approved physical selection blueprint required.')
        if t.get('blueprint_sha256') != sha(blueprint):
            raise ValueError('Final blueprint/test binding differs.')
        sources = sorted({*list((ROOT / 'plugin').rglob('*')), *list(HERE.rglob('*')),
                          ROOT / 'tests/inspection/run.py', ROOT / 'tests/inspection/build.py',
                          ROOT / 'tests/inspection/fixture/WorldFixture.java', ROOT / 'tests/inspection/fixture/plugin.yml',
                          ROOT / 'tests/compatibility/run.py', ROOT / 'tests/compatibility/versions.json',
                          ROOT / 'tests/compatibility/package-lock.json', ROOT / 'config/p0-policy.json',
                          ROOT / 'tests/inspection/coverage.json', blueprint, tests})
        sources = [p for p in sources if p.is_file() and '__pycache__' not in p.parts]
        hashes = {str(p.relative_to(ROOT)): sha(p) for p in sources}
        result['sources'] = hashes
        for filename in hashes:
            destination = evidence / 'source' / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / filename, destination)
        # Reuse the existing compiler with an isolated output, avoiding other agents' build directories.
        boundary.builder.OUTPUT = runtime / 'production-build'
        artifact, _, _ = boundary.builder.build()
        if any(sha(ROOT / filename) != digest for filename, digest in hashes.items() if filename.startswith('plugin/')):
            raise RuntimeError('Production source changed during compilation; retain and retry after stabilization.')
        for filename in ['compile.log', 'compile-checks.log', 'package.log']:
            source = boundary.builder.OUTPUT / filename
            if source.exists():
                shutil.copyfile(source, evidence / filename)
        cache = ROOT / '.local/compatibility/server'
        if sha(cache / 'paper.jar') != lock['paper']['sha256']:
            raise ValueError('Pinned Paper cache hash differs.')
        for directory in ['libraries', 'versions', 'cache']:
            shutil.copytree(cache / directory, runtime / directory)
        shutil.copyfile(cache / 'paper.jar', runtime / 'paper.jar')
        data = runtime / 'plugins/AgentCity'
        data.mkdir(parents=True)
        shutil.copyfile(artifact, runtime / 'plugins/AgentCity.jar')
        shutil.copyfile(artifact, evidence / 'AgentCity.jar')
        shutil.copyfile(blueprint, data / 'blueprint.json')
        shutil.copyfile(tests, data / 'tests.json')
        deployment = boundary.deployment(name, blueprint, tests, int(time.time() * 1000) + 3600000)
        config_bytes = (json.dumps(deployment, indent=2) + '\n').encode()
        (data / 'deployment.json').write_bytes(config_bytes)
        (data / 'bootstrap-grant').write_text(name + '\n' + hashlib.sha256(config_bytes).hexdigest() + '\n')
        (evidence / 'deployment.json').write_bytes(config_bytes)
        plan = {'schema': 'agentcity.sealed-checker-fault.v1', 'purpose': 'isolated_non_token_p1_boundary',
                'run_id': name, 'world': name, 'fault_scenario': scenario, 'declared_variant_ids': variant_ids(scenario),
                'placement_target': [-16, 80, -8], 'stock': b['material_bill'], 'deployment': deployment,
                'blueprint': b, 'post_bootstrap_arbitrary_world_or_stock_api': False,
                'fault_controls': 'One declared fault, one exact checker phase/index barrier, one sealed arm marker.',
                'injected_resources': 'Full operator-seeded circuit and job stock. Unload scenarios use a fixed far diagnostic landing and player spawn, not construction/navigation proof.'}
        plan_bytes = (json.dumps(plan, indent=2) + '\n').encode()
        (runtime / 'boundary-fixture.json').write_bytes(plan_bytes)
        (evidence / 'fixture-plan.json').write_bytes(plan_bytes)
        source = runtime / 'fault-source'
        source.mkdir()
        augment.generate(evidence / 'source/tests/inspection/fixture/WorldFixture.java',
                         evidence / 'source/tests/inspection/faults/SealedFaults.java.inc', source / 'FaultFixture.java')
        shutil.copyfile(source / 'FaultFixture.java', evidence / 'FaultFixture.java')
        classes = runtime / 'fault-classes'
        classes.mkdir()
        cp = ':'.join('/server/' + str(p.relative_to(runtime)) for p in sorted([*runtime.glob('libraries/**/*.jar'), *runtime.glob('versions/**/*.jar')]))
        base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
                '--mount', f'type=bind,src={runtime},dst=/server', lock['java_image']]
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/server/fault-classes', '/server/fault-source/FaultFixture.java'], timeout=60, log_path=evidence / 'compile-fixture.log')
        (classes / 'plugin.yml').write_text("name: AgentCityWorldFixture\nversion: 0.1.0\nmain: org.agentcity.inspection.fixture.FaultFixture\napi-version: '1.21.11'\nload: POSTWORLD\nloadbefore: [AgentCity]\ndescription: Isolated sealed physical missing-observation fault fixture\n")
        (runtime / 'fixture-manifest.mf').write_text('Manifest-Version: 1.0\npaperweight-mappings-namespace: mojang\n\n')
        p0.command(base + ['jar', '--create', '--manifest', '/server/fixture-manifest.mf', '--file', '/server/plugins/AgentCityWorldFixture.jar', '-C', '/server/fault-classes', '.'], timeout=30, log_path=evidence / 'package-fixture.log')
        shutil.copyfile(runtime / 'plugins/AgentCityWorldFixture.jar', evidence / 'AgentCityWorldFixture.jar')
        result['plugin_sha256'] = sha(runtime / 'plugins/AgentCity.jar')
        result['fixture_sha256'] = sha(runtime / 'plugins/AgentCityWorldFixture.jar')
        (runtime / 'eula.txt').write_text('# Owner-authorized isolated local development.\neula=true\n')
        (runtime / 'server.properties').write_text(p0.server_properties().replace('level-name=compatibility-world', 'level-name=' + name).replace('max-players=3', 'max-players=4'))
        docker_env = dict(os.environ, AGENTCITY_API_TOKEN=token)

        def start(label):
            nonlocal attempted
            attempted = True
            p0.command(['docker', 'run', '--detach', '--name', name, '--label', 'agentcity.inspection.faults=true', '--label', f'agentcity.inspection.owner={owner}',
                        '--publish', f'127.0.0.1:{GAME_PORT}:25565', '--publish', f'127.0.0.1:{HTTP_PORT}:25578', '--env', 'AGENTCITY_API_TOKEN',
                        '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}',
                        '--memory', '2g', '--cpus', '2', lock['java_image'], 'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-jar', 'paper.jar', '--nogui'],
                       timeout=90, env=docker_env, log_path=evidence / f'{label}-start.log')
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                logs = p0.command(['docker', 'logs', name], timeout=10, check=False)
                (evidence / f'{label}-server.log').write_text(boundary.redact(logs.stdout + logs.stderr, token))
                state = p0.command(['docker', 'inspect', '--format', '{{.State.Running}}', name], timeout=10, check=False)
                if state.stdout.strip() != 'true':
                    raise RuntimeError('Fault server stopped: ' + boundary.redact((logs.stdout + logs.stderr)[-2000:], token))
                if 'Done (' in logs.stdout + logs.stderr:
                    return
                time.sleep(1)
            raise TimeoutError('Fault server startup exceeded180seconds.')

        def probe(phase):
            env = dict(os.environ, AC_FAULT_TOKEN=token, AC_FAULT_RUNTIME=str(runtime), AC_FAULT_PHASE=phase, AC_FAULT_REPORT=str(evidence / f'{phase}-client.json'))
            with (evidence / f'{phase}-client.log').open('w') as output:
                process = subprocess.run(['node', str(HERE / 'probe.cjs')], cwd=ROOT, env=env, text=True, stdout=output, stderr=subprocess.STDOUT, timeout=190)
            observed = json.loads((evidence / f'{phase}-client.json').read_text()) if (evidence / f'{phase}-client.json').exists() else {}
            if process.returncode or observed.get('status') != 'pass':
                raise RuntimeError(f'{phase} negative probe failed; inspect retained client report/log.')
            result['steps'].append({'phase': phase, 'status': 'pass', 'assertion_groups': len(observed['steps'])})

        start('initial')
        probe('initial')
        if restart:
            errors, removed = boundary.cleanup_owned(name, owner, evidence, 'restart-stop')
            if errors or not removed:
                raise RuntimeError('Owned restart cleanup was not established: ' + str(errors))
            start('restart')
            probe('restart')
        result['status'] = 'pass'
        result['observed_variant_ids'] = variant_ids(scenario)
    except Exception as error:
        result['error'] = boundary.redact(str(error), token)
    finally:
        if attempted:
            errors, removed = boundary.cleanup_owned(name, owner, evidence, 'final-server')
            if errors or not removed:
                result['status'] = 'fail'
                result['cleanup_errors'] = errors or ['Exact owned container removal was not established.']
        for filename in ['fault-observation.json', 'fault-events.jsonl', 'fault-probe-state.json', 'fault-applied', 'boundary-observation.json', 'boundary-events.jsonl',
                         'fixture-initialized', 'plugins/AgentCity/operations.journal', 'plugins/AgentCity/initialized-job']:
            source = runtime / filename
            if source.exists():
                destination = evidence / 'retained' / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
        if (runtime / 'plugins/AgentCity/reports').exists():
            shutil.copytree(runtime / 'plugins/AgentCity/reports', evidence / 'retained/reports')
        for file in evidence.rglob('*'):
            if file.is_file() and file.suffix in ['.json', '.jsonl', '.log', '.txt']:
                try:
                    text = file.read_text()
                    safe = boundary.redact(text, token)
                    if safe != text:
                        file.write_text(safe)
                except UnicodeError:
                    pass
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        result['artifact_hashes'] = {str(p.relative_to(evidence)): sha(p) for p in evidence.rglob('*') if p.is_file()}
        (evidence / 'run-report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'scenario': scenario, 'evidence': str(evidence.relative_to(ROOT)), 'error': result.get('error')}), flush=True)
    if result['status'] != 'pass':
        raise RuntimeError('Sealed physical fault probe did not meet its declared expectation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', choices=SCENARIOS, required=True)
    parser.add_argument('--no-restart', action='store_true')
    args = parser.parse_args()
    run(args.scenario, not args.no_restart)
