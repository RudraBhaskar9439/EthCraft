"""One isolated maintained-runtime candidate smoke; never adopt or edit existing locks."""
from datetime import datetime, timezone
import argparse
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


p0 = module('maintained_p0_helpers', ROOT / 'tests/compatibility/run.py')
boundary = module('maintained_boundary_helpers', ROOT / 'tests/inspection/run.py')
builder = module('maintained_candidate_builder', HERE / 'build.py')
sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()


def run(mode='smoke'):
    candidate = json.loads((HERE / 'candidate.json').read_text())
    java_image = candidate['java_image']
    candidate_jar, source_manifest = builder.build()
    name = 'agentcity-maintained-' + uuid.uuid4().hex[:8]
    owner, token = uuid.uuid4().hex, secrets.token_urlsafe(48)
    runtime, evidence = HERE / '.runtime' / name, HERE / 'runs' / name
    runtime.mkdir(parents=True); evidence.mkdir(parents=True)
    result = {'status': 'fail', 'name': name, 'owner': owner, 'mode': mode, 'purpose': 'isolated maintained non-token compatibility candidate, not adoption', 'started_at': datetime.now(timezone.utc).isoformat(), 'matrix': {**candidate, 'java_image': java_image}, 'candidate_source_manifest': source_manifest, 'independent_humans': 0, 'real_spend_usd': 0}
    attempted = False
    sources = [ROOT / 'backend/src/bot' / file for file in ['construction-worker.cjs', 'minecraft-adapter.cjs', 'checkpoint-store.cjs']]
    if mode == 'full': sources += [ROOT / path for path in ['tests/construction/probe.cjs', 'backend/src/inference/proposal.mjs', 'backend/src/inference/providers.mjs']]
    result['used_source_sha256'] = {str(file.relative_to(ROOT)): sha(file) for file in sources}
    harness = [HERE / file for file in ['run.py', 'build.py', 'smoke.cjs', 'client-profile.cjs', 'candidate.patch', 'source-manifest.json', 'native-probe/NativeProbe.java', 'native-probe/plugin.yml']]
    result['candidate_harness_sha256'] = {str(file.relative_to(HERE)): sha(file) for file in harness}
    for file in harness + sources:
        target = evidence / 'source' / file.relative_to(ROOT); target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(file, target)
    try:
        for port in [25596, 25597]:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('127.0.0.1', port))
        original = ROOT / '.local/construction/runs/agentcity-construction-750b0aae'
        proof = json.loads((ROOT / 'evidence/runs/minecraft-internal/agentcity-construction-750b0aae/run-report.json').read_text())
        assert proof['status'] == 'pass' and sha(original / 'plugins/AgentCity.jar') == proof['plugin_sha256']
        for file, digest in proof['sources'].items():
            if file.startswith('plugin/'):
                assert sha(ROOT / file) == digest, 'Unchanged plugin source required.'
        result['original_plugin_sha256'] = proof['plugin_sha256']
        result['candidate_plugin_sha256'] = sha(candidate_jar)
        plugins = runtime / 'plugins'; plugins.mkdir()
        shutil.copyfile(candidate_jar, plugins / 'AgentCity.jar')
        shutil.copyfile(original / 'plugins/AgentCityConstructionFixture.jar', plugins / 'AgentCityConstructionFixture.jar')
        data = plugins / 'AgentCity'; data.mkdir()
        for filename in ['blueprint.json', 'tests.json', 'construction-access.json']:
            shutil.copyfile(original / 'plugins/AgentCity' / filename, data / filename)
        plan = json.loads((original / 'construction-fixture.json').read_text())
        deployment = {**plan['deployment'], 'serverId': 'maintained-candidate-server', 'jobId': name, 'world': name, 'workDeadlineMs': int(time.time() * 1000) + 3600000, 'reviewDeadlineMs': int(time.time() * 1000) + 4500000}
        plan.update({'run_id': name, 'deployment': deployment})
        encoded = (json.dumps(deployment, indent=2) + '\n').encode()
        (data / 'deployment.json').write_bytes(encoded)
        (data / 'bootstrap-grant').write_text(name + '\n' + hashlib.sha256(encoded).hexdigest() + '\n')
        (runtime / 'construction-fixture.json').write_text(json.dumps(plan, indent=2) + '\n')
        (evidence / 'deployment.json').write_bytes(encoded)
        for key, filename in [('paper', 'paper.jar'), ('ViaVersion', 'plugins/ViaVersion.jar'), ('ViaBackwards', 'plugins/ViaBackwards.jar')]:
            source = HERE / '.cache' / (key + '.jar')
            assert sha(source) == candidate['artifacts'][key]['sha256']
            shutil.copyfile(source, runtime / filename)
        bootstrap = HERE / '.runtime/agentcity-maintained-45cc10e8'
        for directory in ['libraries', 'versions', 'cache']:
            if (bootstrap / directory).exists(): shutil.copytree(bootstrap / directory, runtime / directory)
        # Compile only the additional probe against the historical API; the product JAR is unchanged.
        legacy = ROOT / '.local/compatibility/server'
        legacy_lock = json.loads((ROOT / 'tests/compatibility/versions.json').read_text())
        classes = runtime / 'native-probe-classes'; classes.mkdir()
        jars = sorted([*legacy.glob('libraries/**/*.jar'), *legacy.glob('versions/**/*.jar')])
        classpath = ':'.join('/legacy/' + str(file.relative_to(legacy)) for file in jars)
        base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}', '--mount', f'type=bind,src={runtime},dst=/server', '--mount', f'type=bind,src={legacy},dst=/legacy,readonly', '--mount', f'type=bind,src={HERE / "native-probe"},dst=/source,readonly', '--workdir', '/server', legacy_lock['java_image']]
        p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', classpath, '-d', '/server/native-probe-classes', '/source/NativeProbe.java'], timeout=90, log_path=evidence / 'compile-native-probe.log')
        shutil.copyfile(HERE / 'native-probe/plugin.yml', classes / 'plugin.yml')
        p0.command(base + ['jar', '--create', '--file', '/server/plugins/AgentCityMaintainedNativeProbe.jar', '-C', '/server/native-probe-classes', '.'], timeout=30, log_path=evidence / 'package-native-probe.log')
        (runtime / 'eula.txt').write_text('# Owner-authorized isolated local non-token engineering fixture.\neula=true\n')
        (runtime / 'server.properties').write_text(p0.server_properties().replace('level-name=compatibility-world', 'level-name=' + name))
        attempted = True
        p0.command(['docker', 'run', '--detach', '--name', name, '--label', 'agentcity.maintained.candidate=true', '--label', f'agentcity.inspection.owner={owner}', '--publish', '127.0.0.1:25596:25565', '--publish', '127.0.0.1:25597:25578', '--env', 'AGENTCITY_API_TOKEN', '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server', '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2', java_image, 'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-jar', 'paper.jar', '--nogui'], timeout=90, env=dict(os.environ, AGENTCITY_API_TOKEN=token), log_path=evidence / 'server-start.log')
        for _ in range(240):
            logs = p0.command(['docker', 'logs', name], timeout=10, check=False)
            text = logs.stdout + logs.stderr
            (evidence / 'server.log').write_text(boundary.redact(text, token))
            if 'AgentCity startup failed closed:' in text or 'Construction fixture failed:' in text:
                raise RuntimeError('Candidate plugin failed startup; retained server.log contains the cause.')
            if 'Done (' in text:
                break
            state = p0.command(['docker', 'inspect', '--format', '{{.State.Running}}', name], timeout=10, check=False)
            if state.stdout.strip() != 'true':
                raise RuntimeError('Candidate server stopped; retained server.log contains the cause.')
            time.sleep(1)
        else:
            raise TimeoutError('Candidate startup exceeded240seconds.')
        result['server_started'] = True
        if mode == 'smoke':
            env = dict(os.environ, AC_CANDIDATE_RUNTIME=str(runtime), AC_CANDIDATE_TOKEN=token, AC_CANDIDATE_REPORT=str(evidence / 'smoke.json'))
            with (evidence / 'smoke.log').open('w') as output:
                smoke = subprocess.run(['node', '--require', str(HERE / 'client-profile.cjs'), str(HERE / 'smoke.cjs')], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=300)
            observed = json.loads((evidence / 'smoke.json').read_text())
            assert smoke.returncode == 0 and observed['status'] == 'pass', observed.get('error')
            result.update({'status': 'pass', 'smoke_checks': len(observed['checks']), 'full_144_and_16_case_harness_verified': False, 'production_adopted': False})
        else:
            result['segments'] = []
            for phase in ['initial', 'resume']:
                env = dict(os.environ, AC_CONSTRUCTION_INTERNAL='true', AC_CONSTRUCTION_TOKEN=token, AC_CONSTRUCTION_RUNTIME=str(runtime), AC_CONSTRUCTION_REPORT=str(evidence / f'{phase}-client.json'), AC_CONSTRUCTION_PHASE=phase, AC_CONSTRUCTION_GAME_PORT='25596', AC_CONSTRUCTION_HTTP_PORT='25597', AC_CONSTRUCTION_DEPENDENCY_ROOT=str(ROOT / 'tests/compatibility/node_modules'), AC_CONSTRUCTION_SOURCE_ROOT=str(ROOT))
                with (evidence / f'{phase}-client.log').open('w') as output:
                    process = subprocess.run(['node', '--require', str(HERE / 'client-profile.cjs'), str(ROOT / 'tests/construction/probe.cjs')], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=900)
                observed = json.loads((evidence / f'{phase}-client.json').read_text())
                assert process.returncode == 0 and observed['status'] == 'pass', observed.get('error')
                result['segments'].append({'phase': phase, 'checks': len(observed['checks']), 'status': 'pass'})
            assert observed['inspection']['status'] == 'PASS' and len(observed['inspection']['rows']) == 16
            assert all(row['observed'] == row['expected'] for row in observed['inspection']['rows'])
            result.update({'status': 'pass', 'full_144_and_16_case_harness_verified': True, 'inspection_run_id': observed['inspection']['runId'], 'production_adopted': False})
    except Exception as error:
        result['error'] = boundary.redact(str(error), token)
    finally:
        if attempted:
            errors, removed = boundary.cleanup_owned(name, owner, evidence, 'final-server')
            result['owned_container_removed'] = removed
            if errors:
                result['cleanup_errors'] = errors; result['status'] = 'fail'
        for file in ['maintained-native-probe.json', 'decoded-movement.jsonl', 'construction-observation.json', 'construction-events.jsonl', 'candidate-checkpoint.json', 'construction-checkpoint.json', 'construction-initial.json']:
            source = runtime / file
            if source.exists(): shutil.copyfile(source, evidence / file)
        if (runtime / 'plugins/AgentCity/reports').exists(): shutil.copytree(runtime / 'plugins/AgentCity/reports', evidence / 'reports')
        changed = [file for file, digest in result['used_source_sha256'].items() if sha(ROOT / file) != digest]
        if changed:
            result['changed_source'] = changed; result['status'] = 'fail'
        for file in evidence.glob('*.log'):
            file.write_text(boundary.redact(file.read_text(), token))
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        result['evidence_sha256'] = {file.name: sha(file) for file in sorted(evidence.iterdir()) if file.is_file()}
        (evidence / 'report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'evidence': str(evidence.relative_to(ROOT)), 'error': result.get('error')}))
    if result['status'] != 'pass': raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['smoke', 'full'], default='smoke')
    run(parser.parse_args().mode)
