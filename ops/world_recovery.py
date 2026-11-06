"""Archive a completed stopped fixture, restore a new copy, and run real block/lamp checks."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_host', ROOT / 'scripts/local_host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        while value := stream.read(1024 * 1024):
            result.update(value)
    return result.hexdigest()


def fingerprints(directory):
    return {str(path.relative_to(directory)): sha(path) for path in sorted(directory.rglob('*')) if path.is_file()}


def require_stopped_source(directory):
    containers = host.execute(['docker', 'ps', '-q'], stdout=subprocess.PIPE).stdout.decode().split()
    for identifier in containers:
        mounts = json.loads(host.execute(['docker', 'inspect', '--format', '{{json .Mounts}}', identifier], stdout=subprocess.PIPE).stdout)
        if any(Path(mount.get('Source', '')).resolve() == directory.resolve() for mount in mounts):
            raise RuntimeError('Source fixture is still running; wait for its owner handoff.')


def verify(source_run):
    if not re.fullmatch('agentcity-construction-[a-f0-9]{8}', source_run):
        raise ValueError('A completed internal fixture run ID is required.')
    source = ROOT / '.local/construction/runs' / source_run
    source_evidence = ROOT / 'evidence/runs/minecraft-internal' / source_run
    original = json.loads((source_evidence / 'run-report.json').read_text())
    ownership = json.loads((source_evidence / 'ownership.json').read_text())
    assert ownership['name'] == source_run and Path(ownership['runtime']).resolve() == source.resolve()
    assert re.fullmatch('[a-f0-9]{32}', ownership['owner'])
    assert ownership['labels']['agentcity.inspection.owner'] == ownership['owner']
    assert original['status'] == 'pass' and original.get('economic_bridge') is False
    assert sha(source / 'plugins/AgentCity.jar') == original['plugin_sha256']
    assert sha(source / 'plugins/AgentCityConstructionFixture.jar') == original['fixture_plugin_sha256']
    require_stopped_source(source)
    access_before = host.access_world()
    for port in [25594, 25595]:
        if host.occupied(port):
            raise RuntimeError('Isolated recovery port is occupied; existing service was not changed.')
    run_id, owner, token = uuid.uuid4().hex, uuid.uuid4().hex, secrets.token_urlsafe(48)
    directory = host.LOCAL / 'world-backups' / run_id
    directory.mkdir(parents=True, mode=0o700)
    restored = directory / 'restored'
    output = ROOT / 'tests/recovery/runs' / ('minecraft-' + run_id)
    output.mkdir(parents=True, exist_ok=False)
    name = 'agentcity-recovery-' + run_id[:8]
    report = {'status': 'fail', 'sourceRun': source_run, 'scope': 'Cold restore of a completed isolated internal-material Minecraft fixture; no blockchain link',
              'checks': [], 'sourceOwner': ownership['owner'], 'userAccessWorldTouched': False, 'sourceWorldModified': False, 'realMoneySpent': 0}
    attempted, runtime = False, None
    try:
        before = fingerprints(source)
        archive = directory / 'world.tar'
        with tarfile.open(archive, 'w') as bundle:
            archive.chmod(0o600)
            bundle.add(source, arcname='world', recursive=True)
        assert fingerprints(source) == before
        restored.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(restored, filter='data')
        runtime = restored / 'world'
        assert fingerprints(runtime) == before
        host.private_json(directory / 'manifest.json', {'sourceRun': source_run, 'archiveSha256': sha(archive), 'sourceFingerprints': before})
        report['checks'].append('complete stopped source archived and extracted; all saved file fingerprints match before first boot')
        image = original['runtime_lock']['java_image']
        host.execute(['docker', 'image', 'inspect', image], stdout=subprocess.PIPE)
        started_ms = int(time.time() * 1000)
        attempted = True
        host.execute(['docker', 'run', '--detach', '--pull', 'never', '--name', name,
                      '--label', 'agentcity.recovery=true', '--label', 'agentcity.owner=' + owner,
                      '--publish', '127.0.0.1:25594:25565', '--publish', '127.0.0.1:25595:25578',
                      '--env', 'AGENTCITY_API_TOKEN', '--mount', 'type=bind,src=' + str(runtime) + ',dst=/server',
                      '--workdir', '/server', '--user', str(os.getuid()) + ':' + str(os.getgid()), '--memory', '2g', '--cpus', '2', image,
                      'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', '-Dagentcity.localConstructionResume=true', '-jar', 'paper.jar', '--nogui'],
                     env=dict(os.environ, AGENTCITY_API_TOKEN=token), stdout=subprocess.PIPE)
        for _ in range(120):
            if host.occupied(25595) and (runtime / 'construction-observation.json').exists():
                observed = json.loads((runtime / 'construction-observation.json').read_text())
                if observed.get('observed_at_ms', 0) >= started_ms:
                    break
            actual = json.loads(host.execute(['docker', 'inspect', name], stdout=subprocess.PIPE).stdout)[0]
            if not actual['State']['Running']:
                raise RuntimeError('The isolated restored server stopped; inspect its private log.')
            time.sleep(1)
        else:
            raise TimeoutError('The isolated restored world did not become ready.')
        with (directory / 'inspection.log').open('wb') as stream:
            (directory / 'inspection.log').chmod(0o600)
            host.execute(['node', 'ops/inspect_restored_world.cjs'], env=dict(os.environ, AGENTCITY_RESTORE_RUNTIME=str(runtime), AGENTCITY_API_TOKEN=token, AGENTCITY_RESTORE_STARTED_MS=str(started_ms)), stdout=stream)
        checked = json.loads((runtime / 'restore-check.json').read_text())
        assert checked['status'] == 'pass'
        assert fingerprints(source) == before
        access_after = host.access_world()
        if access_before:
            assert access_after[1]['Id'] == access_before[1]['Id']
            assert access_after[1]['State']['StartedAt'] == access_before[1]['State']['StartedAt']
        shutil.copyfile(runtime / 'restore-check.json', output / 'inspection-check.json')
        report.update(status='pass', checks=report['checks'] + checked['checks'], savedFileCount=len(before),
                      archiveSha256=sha(archive), backupDirectory=str(directory.relative_to(ROOT)),
                      restoredInspectionId=checked['inspection']['runId'], sourceFingerprintsUnchanged=True,
                      userAccessContainerUnchanged=True)
    except Exception as error:
        report['status'] = 'fail'
        report['error'] = {'type': type(error).__name__, 'message': str(error).replace(token, '<redacted>')[:300]}
        raise
    finally:
        if runtime and (runtime / 'restore-check.json').exists():
            shutil.copyfile(runtime / 'restore-check.json', output / 'inspection-check.json')
        if attempted:
            try:
                inspected = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
                if inspected.returncode == 0:
                    actual = json.loads(inspected.stdout)[0]
                    if actual['Config'].get('Labels', {}).get('agentcity.owner') != owner or actual['Config']['Labels'].get('agentcity.recovery') != 'true':
                        raise RuntimeError('Refused cleanup: exact recovery container owner differs.')
                    host.execute(['docker', 'stop', '--time', '20', name], stdout=subprocess.PIPE)
                    host.execute(['docker', 'rm', name], stdout=subprocess.PIPE)
                    report['ownedCloneRemoved'] = True
            except Exception as error:
                report['status'] = 'fail'
                report['cleanupError'] = str(error).replace(token, '<redacted>')[:300]
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['sources'] = {name: sha(ROOT / name) for name in ['ops/world_recovery.py', 'ops/inspect_restored_world.cjs', 'scripts/local_host.py', 'backend/src/bot/construction-worker.cjs', 'tests/compatibility/package-lock.json']}
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'evidence': str((output / 'report.json').relative_to(ROOT))}))
    return report


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 ops/world_recovery.py COMPLETED_INTERNAL_RUN_ID')
    if verify(sys.argv[1])['status'] != 'pass':
        raise SystemExit(1)
