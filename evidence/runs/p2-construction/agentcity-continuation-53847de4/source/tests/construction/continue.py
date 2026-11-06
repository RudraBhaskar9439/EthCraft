"""Continue one retained local construction world without restoring blocks or stock."""
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
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('construction_continuation_helpers', ROOT / 'tests/construction/run.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
p0, boundary, sha = harness.p0, harness.boundary, harness.sha


def run(previous, previous_segment=None):
    if not re.fullmatch(r'agentcity-construction-[a-f0-9]{8}', previous):
        raise ValueError('An exact retained construction run is required.')
    runtime = ROOT / '.local/construction/runs' / previous
    predecessor = ROOT / 'evidence/runs/p2-construction' / previous
    old_report = json.loads((predecessor / 'run-report.json').read_text())
    old_client = json.loads((predecessor / 'resume-client.json').read_text())
    if old_report['status'] != 'fail' or old_report.get('scenario') != 'build':
        raise ValueError('Only a retained failed build may be continued.')
    segment_report = old_report
    segment_directory = predecessor
    if previous_segment is not None:
        if not re.fullmatch(r'agentcity-continuation-[a-f0-9]{8}', previous_segment):
            raise ValueError('An exact retained continuation segment is required.')
        segment_directory = ROOT / 'evidence/runs/p2-construction' / previous_segment
        segment_report = json.loads((segment_directory / 'run-report.json').read_text())
        if segment_report['status'] != 'fail' or segment_report['source_run'] != previous:
            raise ValueError('The prior failed segment must belong to this original world.')
        old_client = json.loads((segment_directory / 'resume-client.json').read_text())
    checkpoint = json.loads((runtime / 'construction-checkpoint.json').read_text())
    receipts = [row for row in checkpoint['receipts'] if row['action'] == 'PLACE']
    if checkpoint.get('pending') is not None or not receipts:
        raise ValueError('Unknown pending construction must be reconciled before continuation.')
    baseline_derivation = None
    if 'waiting_observation' in old_client:
        old_world = old_client['waiting_observation']
    else:
        completion = next((row for row in old_client.get('checks', []) if row['name'] == 'complete-native-build-consumes-exact144-items-once' and row['status'] == 'pass'), None)
        if len(receipts) != 144 or checkpoint.get('inventory') or not completion or old_client.get('worker', {}).get('status') != 'built':
            raise ValueError('An inspection-only continuation requires retained proof of the complete144-item build.')
        final_map = json.loads((segment_directory / 'retained/construction-observation.json').read_text())
        if final_map['stock']:
            raise ValueError('Completed-world retained stock is not empty.')
        original_people = json.loads((predecessor / 'resume-client.json').read_text())['waiting_observation']['players']
        people = json.loads(json.dumps(original_people))
        people['WorldBuilder']['items'] = checkpoint['inventory']
        old_world = {'blocks': final_map['blocks'], 'stock': final_map['stock'], 'players': people}
        baseline_derivation = {'kind': 'completed-world evidence composition, not a prior live observation',
                               'checkpoint_sha256': sha(runtime / 'construction-checkpoint.json'),
                               'retained_blocks_sha256': sha(segment_directory / 'retained/construction-observation.json'),
                               'completion_check': completion,
                               'unchanged_other_roles_source': str((predecessor / 'resume-client.json').relative_to(ROOT))}
    plan = json.loads((runtime / 'construction-fixture.json').read_text())
    deployment = json.loads((runtime / 'plugins/AgentCity/deployment.json').read_text())
    if plan['run_id'] != previous or deployment['world'] != previous or deployment != plan['deployment']:
        raise ValueError('Original world and deployment identities must match exactly.')
    if (runtime / 'fixture-initialized').read_text() != previous + '\n' or not (runtime / previous / 'level.dat').is_file():
        raise ValueError('Original world and fixture marker are required; no bootstrap is allowed.')
    if sha(runtime / 'plugins/AgentCity/deployment.json') != sha(predecessor / 'deployment.json'):
        raise ValueError('Original immutable deployment changed.')
    fixed = ['deployment.json', 'blueprint.json', 'tests.json', 'construction-access.json']
    fixed_hashes = {name: sha(runtime / 'plugins/AgentCity' / name) for name in fixed}
    if fixed_hashes['construction-access.json'] != deployment['constructionAccessSha256'] or fixed_hashes['blueprint.json'] != deployment['blueprintSha256']:
        raise ValueError('Original blueprint/access binding changed.')
    if sha(runtime / 'plugins/AgentCity.jar') != segment_report['plugin_sha256']:
        raise ValueError('Original plugin artifact differs from retained predecessor evidence.')
    if sha(runtime / 'plugins/AgentCityConstructionFixture.jar') != segment_report['fixture_plugin_sha256']:
        raise ValueError('Current fixture artifact differs from retained predecessor evidence.')
    if int(time.time() * 1000) >= deployment['workDeadlineMs']:
        raise ValueError('Original immutable work deadline expired; it cannot be extended here.')
    lock = json.loads((ROOT / 'tests/compatibility/versions.json').read_text())
    p0.validate_versions(lock)
    if sha(runtime / 'paper.jar') != lock['paper']['sha256']:
        raise ValueError('Pinned Paper artifact changed.')
    name = 'agentcity-continuation-' + uuid.uuid4().hex[:8]
    evidence = ROOT / 'evidence/runs/p2-construction' / name
    evidence.mkdir(parents=True)
    owner, token = uuid.uuid4().hex, secrets.token_urlsafe(48)
    attempted = False
    result = {'schema': 'agentcity.p2.continuation-run.v1', 'name': name, 'source_run': previous,
              'status': 'fail', 'started_at': datetime.now(timezone.utc).isoformat(),
              'source_segmented_execution': True, 'full_phase_gate_passed': False,
              'independent_humans': 0, 'world_restoration': False, 'stock_injection': False,
              'original_failure_sha256': sha(predecessor / 'run-report.json'),
              'original_plugin_sha256': old_report['plugin_sha256'],
              'original_fixture_sha256': old_report['fixture_plugin_sha256'],
              'previous_plugin_sha256': sha(runtime / 'plugins/AgentCity.jar'),
              'previous_fixture_sha256': sha(runtime / 'plugins/AgentCityConstructionFixture.jar'),
              'previous_segment': previous_segment,
              'previous_segment_report_sha256': sha(segment_directory / 'run-report.json'),
              'original_configuration_sha256': fixed_hashes, 'original_native_placements': len(receipts)}
    result['baseline_derivation'] = baseline_derivation
    try:
        for port in [25582, 25583]:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        sources = [p for directory in ['plugin', 'backend/src/bot', 'tests/construction'] for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
        sources += [ROOT / p for p in ['fixtures/blueprints/calculator-v1.json', 'fixtures/test-manifests/calculator-v1.json', 'fixtures/construction/access-v1.json', 'tests/compatibility/versions.json', 'tests/compatibility/package-lock.json']]
        result['sources'] = {str(p.relative_to(ROOT)): sha(p) for p in sorted(sources)}
        result['changed_source_paths'] = [path for path, digest in result['sources'].items() if segment_report.get('sources', {}).get(path) != digest]
        for source in sources:
            target = evidence / 'source' / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for file in ['AgentCity.jar', 'AgentCityConstructionFixture.jar']:
            shutil.copyfile(runtime / 'plugins' / file, evidence / ('previous-' + file))
        shutil.copyfile(predecessor / 'run-report.json', evidence / 'previous-failed-run.json')
        if previous_segment:
            shutil.copyfile(segment_directory / 'run-report.json', evidence / 'previous-segment-failed-run.json')
        shutil.copyfile(runtime / 'construction-checkpoint.json', evidence / 'previous-checkpoint.json')
        baseline = {'schema': 'agentcity.p2.continuation-baseline.v1', 'source_run': previous_segment or previous,
                    'jobId': deployment['jobId'], 'completed': len(receipts), 'revision': receipts[-1]['revision'],
                    'inventory': old_world['players']['WorldBuilder']['items'], 'stock': old_world['stock'],
                    'blocks': old_world['blocks'], 'players': old_world['players'],
                    'progress_hint_count': len(checkpoint['completed']), 'derivation': baseline_derivation}
        if sum(baseline['inventory'].values()) + sum(baseline['stock'].values()) + baseline['completed'] != 144:
            raise ValueError('Retained actual materials and applied placement receipts do not conserve144items.')
        baseline_path = evidence / 'continuation-baseline.json'
        baseline_path.write_text(json.dumps(baseline, indent=2) + '\n')
        build = evidence / 'build'
        build.mkdir()
        classes, fixture = build / 'plugin-classes', build / 'fixture-classes'
        classes.mkdir(); fixture.mkdir()
        source_root = evidence / 'source'
        cp = ':'.join('/server/' + str(p.relative_to(runtime)) for p in sorted([*runtime.glob('libraries/**/*.jar'), *runtime.glob('versions/**/*.jar')]))
        base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}', '--mount', f'type=bind,src={runtime},dst=/server,readonly', '--mount', f'type=bind,src={source_root},dst=/source,readonly', '--mount', f'type=bind,src={build},dst=/output', lock['java_image']]
        java_sources = ['/source/' + str(p.relative_to(source_root)) for p in (source_root / 'plugin/src/main/java').rglob('*.java')]
        print(name + ': compiling frozen source segment; original world and configuration retained', flush=True)
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/output/plugin-classes', *java_sources], timeout=90, log_path=evidence / 'compile-plugin.log')
        shutil.copytree(source_root / 'plugin/src/main/resources', classes, dirs_exist_ok=True)
        p0.command(base + ['jar', '--create', '--file', '/output/AgentCity.jar', '--manifest', '/source/plugin/src/main/resources/META-INF/MANIFEST.MF', '-C', '/output/plugin-classes', '.'], timeout=30, log_path=evidence / 'package-plugin.log')
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', cp, '-d', '/output/fixture-classes', '/source/tests/construction/fixture/ConstructionFixture.java'], timeout=60, log_path=evidence / 'compile-fixture.log')
        shutil.copyfile(source_root / 'tests/construction/fixture/plugin.yml', fixture / 'plugin.yml')
        p0.command(base + ['jar', '--create', '--file', '/output/AgentCityConstructionFixture.jar', '-C', '/output/fixture-classes', '.'], timeout=30, log_path=evidence / 'package-fixture.log')
        if any(sha(ROOT / path) != digest for path, digest in result['sources'].items()):
            raise RuntimeError('Source changed during continuation compilation; attempt preserved.')
        for file in ['AgentCity.jar', 'AgentCityConstructionFixture.jar']:
            shutil.copyfile(build / file, runtime / 'plugins' / file)
        result['plugin_sha256'] = sha(runtime / 'plugins/AgentCity.jar')
        result['fixture_plugin_sha256'] = sha(runtime / 'plugins/AgentCityConstructionFixture.jar')
        attempted = True
        p0.command(['docker', 'run', '--detach', '--name', name, '--label', 'agentcity.inspection.boundary=true', '--label', f'agentcity.inspection.owner={owner}', '--publish', '127.0.0.1:25582:25565', '--publish', '127.0.0.1:25583:25578', '--env', 'AGENTCITY_API_TOKEN', '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2', lock['java_image'], 'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-Dagentcity.localConstructionResume=true', '-jar', 'paper.jar', '--nogui'], timeout=90, env=dict(os.environ, AGENTCITY_API_TOKEN=token), log_path=evidence / 'server-start.log')
        until = time.monotonic() + 120
        while time.monotonic() < until:
            logs = p0.command(['docker', 'logs', name], timeout=10, check=False)
            text = boundary.redact(logs.stdout + logs.stderr, token)
            (evidence / 'server.log').write_text(text)
            failed = next((line for line in text.splitlines() if 'startup failed closed:' in line or 'Construction fixture failed:' in line), None)
            if failed:
                raise RuntimeError(failed)
            if 'Done (' in text:
                break
            running = p0.command(['docker', 'inspect', '--format', '{{.State.Running}}', name], timeout=10, check=False)
            if running.stdout.strip() != 'true':
                raise RuntimeError('Continuation server stopped before readiness.')
            time.sleep(1)
        else:
            raise TimeoutError('Continuation startup exceeded120seconds.')
        print(name + ': verifying original137-placement world and continuing actual remaining stock', flush=True)
        env = dict(os.environ, AC_CONSTRUCTION_TOKEN=token, AC_CONSTRUCTION_RUNTIME=str(runtime), AC_CONSTRUCTION_REPORT=str(evidence / 'resume-client.json'), AC_CONSTRUCTION_PHASE='resume', AC_CONSTRUCTION_GAME_PORT='25582', AC_CONSTRUCTION_HTTP_PORT='25583', AC_CONSTRUCTION_DEPENDENCY_ROOT=str(ROOT / 'tests/compatibility/node_modules'), AC_CONSTRUCTION_SOURCE_ROOT=str(source_root), AC_CONSTRUCTION_CONTINUATION_BASELINE=str(baseline_path))
        with (evidence / 'resume-client.log').open('w') as output:
            process = subprocess.run(['node', str(source_root / 'tests/construction/probe.cjs')], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, text=True, timeout=600)
        client = json.loads((evidence / 'resume-client.json').read_text())
        if process.returncode or client['status'] != 'pass':
            raise RuntimeError('Continuation client failed; retained baseline, logs and diagnostics explain the result.')
        result['status'] = 'pass'
    except Exception as error:
        result['error'] = boundary.redact(str(error), token)
    finally:
        if attempted:
            errors, removed = boundary.cleanup_owned(name, owner, evidence, 'final-server')
            if errors or not removed:
                result['status'] = 'fail'; result['cleanup_errors'] = errors or ['Owned continuation container removal was not proved.']
        for relative in ['construction-observation.json', 'construction-events.jsonl', 'construction-checkpoint.json', 'plugins/AgentCity/operations.journal', 'plugins/AgentCity/initialized-job']:
            source = runtime / relative
            if source.is_file():
                target = evidence / 'retained' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        if (runtime / 'plugins/AgentCity/reports').exists():
            shutil.copytree(runtime / 'plugins/AgentCity/reports', evidence / 'retained/reports')
        result['configuration_unchanged'] = all(sha(runtime / 'plugins/AgentCity' / file) == digest for file, digest in fixed_hashes.items())
        result['original_failure_unchanged'] = sha(predecessor / 'run-report.json') == result['original_failure_sha256']
        result['previous_segment_unchanged'] = sha(segment_directory / 'run-report.json') == result['previous_segment_report_sha256']
        changed = [path for path, digest in result.get('sources', {}).items() if sha(ROOT / path) != digest]
        if changed or not result['configuration_unchanged'] or not result['original_failure_unchanged'] or not result['previous_segment_unchanged']:
            result['status'] = 'fail'; result['source_integrity_changed'] = changed
        for file in evidence.rglob('*'):
            if file.is_file() and file.suffix in ['.json', '.jsonl', '.log', '.txt']:
                original = file.read_text(); cleaned = boundary.redact(original, token)
                if cleaned != original:
                    file.write_text(cleaned)
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        result['retained_artifacts'] = {str(p.relative_to(evidence)): sha(p) for p in evidence.rglob('*') if p.is_file()}
        (evidence / 'run-report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'evidence': str(evidence.relative_to(ROOT)), 'error': result.get('error')}), flush=True)
    if result['status'] != 'pass':
        raise RuntimeError('Continuation did not pass; original failed evidence is unchanged.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-run', required=True)
    parser.add_argument('--previous-segment')
    args = parser.parse_args()
    run(args.from_run, args.previous_segment)
