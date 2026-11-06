"""Run focused real Survival construction against a fresh local non-token world."""
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

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'tests/construction'
GAME_PORT, HTTP_PORT = 25582, 25583


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


boundary = module('construction_boundary_helpers', ROOT / 'tests/inspection/run.py')
p0 = boundary.p0
sha = boundary.sha


def validate_access(blueprint, access):
    final = {tuple(p['position']) for p in blueprint['placements']}
    positions = [tuple(p) for p in access['positions']]
    assert access['schema'] == 'agentcity.construction-access.v1'
    assert len(positions) == len(set(positions)) and not final.intersection(positions)
    assert all(len(p) == 3 and all(type(n) is int for n in p) and -4 <= p[0] <= 27 and 0 <= p[1] <= 14 and -4 <= p[2] <= 11 for p in positions)
    assert len(access['stances']) == len(final)
    assert sum(blueprint['material_bill'].values()) == len(final) == 144


def run(scenario='build'):
    lock = json.loads((ROOT / 'tests/compatibility/versions.json').read_text())
    p0.validate_versions(lock)
    name = 'agentcity-construction-' + uuid.uuid4().hex[:8]
    owner, token = uuid.uuid4().hex, secrets.token_urlsafe(48)
    runtime = ROOT / '.local/construction/runs' / name
    evidence = ROOT / 'evidence/runs/p2-construction' / name
    runtime.mkdir(parents=True)
    evidence.mkdir(parents=True)
    attempted = False
    result = {'schema': 'agentcity.p2.construction-run.v1', 'name': name, 'status': 'fail',
              'purpose': 'development execution and affected regression; not a phase approval',
              'started_at': datetime.now(timezone.utc).isoformat(), 'runtime_lock': lock,
              'independent_humans': 0, 'full_phase_gate_passed': False,
              'scenario': scenario,
              'injected_resources': 'Fixed hash-bound operator glass access; build gets144stockitems, shortage withholds65stonebricks in a separate operator reserve, occupied injects one wrong glass target. No restoration or runtime edit API; no token backing.',
              'ports': {'host': '127.0.0.1', 'game': GAME_PORT, 'control_http': HTTP_PORT}, 'steps': []}
    try:
        for port in [GAME_PORT, HTTP_PORT]:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        gate = p0.command(['python3', 'scripts/check_phase.py', 'P1'], timeout=30, check=False, log_path=evidence / 'current-p1-gate.log')
        result['current_prerequisite_gate_ready'] = gate.returncode == 0
        result['entry_scope'] = 'P1 was verified before P2 changes; changed shared plugin requires renewed P1 review before P2 approval.'
        sources = [p for directory in ['plugin', 'backend/src/bot', 'tests/construction'] for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
        sources += [ROOT / p for p in ['fixtures/blueprints/calculator-v1.json', 'fixtures/test-manifests/calculator-v1.json', 'fixtures/construction/access-v1.json', 'tests/compatibility/versions.json', 'tests/compatibility/package-lock.json', 'tests/inspection/build.py', 'config/p0-policy.json']]
        result['sources'] = {str(p.relative_to(ROOT)): sha(p) for p in sorted(sources)}
        for source in sources:
            dest = evidence / 'source' / source.relative_to(ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
        source_root = evidence / 'source'
        blueprint = source_root / 'fixtures/blueprints/calculator-v1.json'
        tests = source_root / 'fixtures/test-manifests/calculator-v1.json'
        access = source_root / 'fixtures/construction/access-v1.json'
        b, t, a = [json.loads(p.read_text()) for p in [blueprint, tests, access]]
        validate_access(b, a)
        assert t['blueprint_sha256'] == sha(blueprint) and t['timing_calibrated']
        print(name + ': compiling frozen construction fixture and current plugin', flush=True)
        artifact, _, _ = boundary.builder.build()
        if any(sha(ROOT / p) != digest for p, digest in result['sources'].items()):
            raise RuntimeError('Source changed during compilation; preserve attempt and retry frozen source.')
        cache = ROOT / '.local/compatibility/server'
        if sha(cache / 'paper.jar') != lock['paper']['sha256']:
            raise RuntimeError('Pinned cached Paper checksum mismatch.')
        for directory in ['libraries', 'versions', 'cache']:
            shutil.copytree(cache / directory, runtime / directory)
        shutil.copyfile(cache / 'paper.jar', runtime / 'paper.jar')
        data = runtime / 'plugins/AgentCity'
        data.mkdir(parents=True)
        shutil.copyfile(artifact, runtime / 'plugins/AgentCity.jar')
        for source, target in [(blueprint, 'blueprint.json'), (tests, 'tests.json'), (access, 'construction-access.json')]:
            shutil.copyfile(source, data / target)
        deployment = boundary.deployment(name, blueprint, tests, int(time.time() * 1000) + 3600000)
        deployment['constructionAccessSha256'] = sha(access)
        encoded = (json.dumps(deployment, indent=2) + '\n').encode()
        (data / 'deployment.json').write_bytes(encoded)
        (data / 'bootstrap-grant').write_text(name + '\n' + hashlib.sha256(encoded).hexdigest() + '\n')
        (evidence / 'deployment.json').write_bytes(encoded)
        stock = dict(b['material_bill'])
        withheld = {}
        if scenario == 'shortage':
            withheld['minecraft:stone_bricks'] = stock.pop('minecraft:stone_bricks')
        occupied = next(p['position'] for p in b['placements'] if p['block'] == 'minecraft:stone_bricks') if scenario == 'occupied' else None
        plan = {'schema': 'agentcity.construction-fixture.v1', 'purpose': 'isolated_non_token_p2_construction',
                'run_id': name, 'deployment': deployment, 'blueprint': b, 'construction_access': a,
                'scenario': scenario, 'material_bill': stock, 'withheld_stock': withheld,
                'operator_reserve_chest': [-18, 81, 5] if withheld else None,
                'occupied_target_relative': occupied,
                'final_circuit_seeded': False, 'post_bootstrap_mutation_api': False}
        for dest in [runtime / 'construction-fixture.json', evidence / 'fixture-plan.json']:
            dest.write_text(json.dumps(plan, indent=2) + '\n')
        classes = runtime / 'fixture-classes'
        classes.mkdir()
        cp = ':'.join('/server/' + str(p.relative_to(runtime)) for p in sorted([*runtime.glob('libraries/**/*.jar'), *runtime.glob('versions/**/*.jar')]))
        base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}', '--mount', f'type=bind,src={runtime},dst=/server', '--mount', f'type=bind,src={source_root / "tests/construction/fixture"},dst=/source,readonly', lock['java_image']]
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/server/fixture-classes', '/source/ConstructionFixture.java'], timeout=60, log_path=evidence / 'compile-fixture.log')
        shutil.copyfile(source_root / 'tests/construction/fixture/plugin.yml', classes / 'plugin.yml')
        p0.command(base + ['jar', '--create', '--file', '/server/plugins/AgentCityConstructionFixture.jar', '-C', '/server/fixture-classes', '.'], timeout=30, log_path=evidence / 'package-fixture.log')
        result['plugin_sha256'] = sha(runtime / 'plugins/AgentCity.jar')
        result['fixture_plugin_sha256'] = sha(runtime / 'plugins/AgentCityConstructionFixture.jar')
        (runtime / 'eula.txt').write_text('# Owner-authorized isolated local engineering fixture.\neula=true\n')
        (runtime / 'server.properties').write_text(p0.server_properties().replace('level-name=compatibility-world', 'level-name=' + name))
        attempted = True
        p0.command(['docker', 'run', '--detach', '--name', name, '--label', 'agentcity.inspection.boundary=true', '--label', f'agentcity.inspection.owner={owner}', '--publish', f'127.0.0.1:{GAME_PORT}:25565', '--publish', f'127.0.0.1:{HTTP_PORT}:25578', '--env', 'AGENTCITY_API_TOKEN', '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2', lock['java_image'], 'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-jar', 'paper.jar', '--nogui'], timeout=90, env=dict(os.environ, AGENTCITY_API_TOKEN=token), log_path=evidence / 'server-start.log')
        until = time.monotonic() + 180
        while time.monotonic() < until:
            logs = p0.command(['docker', 'logs', name], timeout=10, check=False)
            (evidence / 'server.log').write_text(boundary.redact(logs.stdout + logs.stderr, token))
            if 'Done (' in logs.stdout + logs.stderr:
                break
            state = p0.command(['docker', 'inspect', '--format', '{{.State.Running}}', name], timeout=10, check=False)
            if state.stdout.strip() != 'true':
                raise RuntimeError('Construction server stopped; retained server.log explains failure.')
            time.sleep(1)
        else:
            raise TimeoutError('Construction server startup exceeded180seconds.')
        for phase in (['initial', 'resume'] if scenario == 'build' else ['initial']):
            print(name + ': executing real Survival client phase ' + phase, flush=True)
            env = dict(os.environ, AC_CONSTRUCTION_TOKEN=token, AC_CONSTRUCTION_RUNTIME=str(runtime), AC_CONSTRUCTION_REPORT=str(evidence / f'{phase}-client.json'), AC_CONSTRUCTION_PHASE=phase, AC_CONSTRUCTION_GAME_PORT=str(GAME_PORT), AC_CONSTRUCTION_HTTP_PORT=str(HTTP_PORT), AC_CONSTRUCTION_DEPENDENCY_ROOT=str(ROOT / 'tests/compatibility/node_modules'), AC_CONSTRUCTION_SOURCE_ROOT=str(source_root))
            with (evidence / f'{phase}-client.log').open('w') as output:
                process = subprocess.run(['node', str(source_root / 'tests/construction/probe.cjs')], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, text=True, timeout=900)
            observed = json.loads((evidence / f'{phase}-client.json').read_text())
            if process.returncode or observed.get('status') != 'pass':
                raise RuntimeError('Construction ' + phase + ' client failed; see retained client.json/log.')
            result['steps'].append({'phase': phase, 'status': observed['status'], 'checks': len(observed['checks'])})
        result['status'] = 'pass'
    except Exception as error:
        result['error'] = boundary.redact(str(error), token)
    finally:
        if attempted:
            errors, removed = boundary.cleanup_owned(name, owner, evidence, 'final-server')
            if errors or not removed:
                result['status'] = 'fail'
                result['cleanup_errors'] = errors or ['Exact owned container removal was not proved.']
        for source in ['construction-observation.json', 'construction-events.jsonl', 'construction-checkpoint.json', 'construction-initial.json', 'plugins/AgentCity/operations.journal', 'plugins/AgentCity/initialized-job']:
            origin = runtime / source
            if origin.exists():
                target = evidence / 'retained' / source
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(origin, target)
        if (runtime / 'plugins/AgentCity/reports').exists():
            shutil.copytree(runtime / 'plugins/AgentCity/reports', evidence / 'retained/reports')
        changed = [p for p, digest in result.get('sources', {}).items() if not (ROOT / p).is_file() or sha(ROOT / p) != digest]
        if changed:
            result['status'] = 'fail'
            result['source_integrity_changed_during_attempt'] = changed
        for file in evidence.rglob('*'):
            if file.is_file() and file.suffix in ['.log', '.json', '.jsonl', '.txt']:
                original = file.read_text()
                cleaned = boundary.redact(original, token)
                if cleaned != original:
                    file.write_text(cleaned)
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        result['retained_artifacts'] = {str(p.relative_to(evidence)): sha(p) for p in evidence.rglob('*') if p.is_file()}
        (evidence / 'run-report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'evidence': str(evidence.relative_to(ROOT)), 'error': result.get('error')}), flush=True)
    if result['status'] != 'pass':
        raise RuntimeError('Construction development run failed; prior evidence remains preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--scenario', choices=['build', 'shortage', 'occupied'], default='build')
    args = parser.parse_args()
    if args.self_check:
        validate_access(json.loads((ROOT / 'fixtures/blueprints/calculator-v1.json').read_text()), json.loads((ROOT / 'fixtures/construction/access-v1.json').read_text()))
        assert GAME_PORT != HTTP_PORT and boundary.owns_container('a' * 32, 'a' * 32)
        print('PASS: fixed access bounds, disjointness, stock bill and owned-container guard')
    else:
        run(args.scenario)
