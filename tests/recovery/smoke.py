"""Focused real PostgreSQL restore proof; does not restart services or execute restored jobs."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('agentcity_local_host', ROOT / 'scripts/local_host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
checks = []
run_id = uuid.uuid4().hex
output = ROOT / 'tests/recovery/runs' / run_id / 'report.json'
report = {'status': 'fail', 'startedAt': datetime.now(timezone.utc).isoformat(), 'checks': checks,
          'scope': 'Actual owned laptop services and online PostgreSQL dump/isolated restore; no live database replacement or chain/world rollback',
          'realMoneySpent': 0, 'liveJobsExecutedByRestore': 0, 'serviceRestartPerformed': False}
try:
    before = host.owned_postgres()
    for _ in range(3):
        health = host.status()
        if health['ready']:
            break
        time.sleep(1)
    report['health'] = health
    assert health['ready'], 'Unready services: ' + ','.join(name for name, item in health['services'].items() if not item['ready'])
    checks.append('six current loopback services pass bounded health checks without restart')

    foreign = copy.deepcopy(before)
    foreign['Config']['Labels']['agentcity.owner'] = 'foreign-owner'
    with patch.object(host, 'execute', return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps([foreign]).encode())):
        try:
            host.owned_postgres()
        except RuntimeError:
            pass
        else:
            raise AssertionError('A foreign PostgreSQL owner was accepted.')
    checks.append('a foreign container owner is refused before backup or restore')

    backup = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else host.backup()
    manifest = json.loads((backup / 'manifest.json').read_text())
    assert (backup.stat().st_mode & 0o777) == 0o700
    assert all((backup / name).stat().st_mode & 0o777 == 0o600 for name in ['database.dump', 'manifest.json'])
    restored = host.restore_check(backup)
    assert restored['tablesVerified'] > 0 and restored['rowsVerified'] > 0
    assert restored['liveDatabaseReplaced'] is False
    report['restore'] = restored
    report['backupDirectory'] = str(backup.relative_to(ROOT))
    checks.append('actual pg_dump/pg_restore preserves every table row count and content fingerprint from one exported snapshot')

    corrupt = host.LOCAL / 'backups' / ('corrupt-check-' + run_id)
    shutil.copytree(backup, corrupt)
    try:
        with (corrupt / 'database.dump').open('ab') as stream:
            stream.write(b'corruption-check')
        try:
            host.restore_check(corrupt)
        except RuntimeError as error:
            assert 'checksum' in str(error)
        else:
            raise AssertionError('A corrupted archive was accepted.')
    finally:
        shutil.rmtree(corrupt)
    after = host.owned_postgres()
    assert before['Id'] == after['Id'] and before['State']['StartedAt'] == after['State']['StartedAt']
    checks.append('archive corruption is refused before database creation; the live container and start time remain unchanged')
    report['status'] = 'pass'
except Exception as error:
    report['error'] = {'type': type(error).__name__, 'message': str(error)[:300]}
    raise
finally:
    report['finishedAt'] = datetime.now(timezone.utc).isoformat()
    output.parent.mkdir(parents=True, exist_ok=False)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'checks': len(checks), 'evidence': str(output.relative_to(ROOT))}))
