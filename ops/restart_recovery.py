"""Coordinated restart proof for only the saved AgentCity console and PostgreSQL owner."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_host', ROOT / 'scripts/local_host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def fingerprint():
    return json.loads(host.execute(['node', 'ops/postgres_snapshot.mjs', 'fingerprint'], stdout=subprocess.PIPE).stdout)['tables']


def ledger_counts(tables):
    return [{'schema': table['schema'], 'table': table['table'], 'rows': table['rows']} for table in tables
            if re.search('job|intent|receipt|claim|stock|agreement|outbox|ledger|purchas|destination|balance|allocation', table['table'])]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def console_owner():
    listening = host.execute(['lsof', '-nP', '-iTCP:8789', '-sTCP:LISTEN', '-t'], stdout=subprocess.PIPE).stdout.decode().split()
    if len(listening) != 1:
        raise RuntimeError('Exactly one saved console listener is required.')
    pid = int(listening[0])
    records = []
    for path in host.LOCAL.glob('console-*.json'):
        data = json.loads(path.read_text())
        if data.get('pid') == pid and data.get('loopbackPort') == 8789:
            records.append(path)
    if len(records) != 1:
        raise RuntimeError('The console listener does not match one saved host PID record.')
    uid = int(host.execute(['ps', '-p', str(pid), '-o', 'uid='], stdout=subprocess.PIPE).stdout)
    command = host.execute(['ps', '-p', str(pid), '-o', 'command='], stdout=subprocess.PIPE).stdout.decode().strip()
    cwd = host.execute(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], stdout=subprocess.PIPE).stdout.decode().splitlines()
    if uid != os.getuid() or command != 'node backend/src/server.mjs' or 'n' + str(ROOT) not in cwd:
        raise RuntimeError('The saved console PID has a foreign user, command or workspace.')
    return {'pid': pid, 'savedRecord': str(records[0].relative_to(ROOT)), 'uid': uid, 'workspaceAndCommandVerified': True}


def container_starts():
    ids = host.execute(['docker', 'ps', '-q'], stdout=subprocess.PIPE).stdout.decode().split()
    result = {}
    for identifier in ids:
        if identifier == host.owned_postgres()['Id'][:12]:
            continue
        started = host.execute(['docker', 'inspect', '--format', '{{json .State.StartedAt}}', identifier], stdout=subprocess.PIPE).stdout.decode().strip()
        result[identifier] = started
    return result


def anvil_head():
    return host.http_json(8547, '/', {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['latest', False]})['result']['hash']


def console_results():
    value = host.http_json(8789, '/api/status')
    if value.get('running') is not False:
        raise RuntimeError('A console job is running; restart was refused.')
    return {name: {key: value.get(name, {}).get(key) for key in ['runId', 'jobId', 'status']} for name in ['result', 'publicResult']}


def verify():
    identifier = uuid.uuid4().hex
    private = host.LOCAL / 'restart-checks' / identifier
    private.mkdir(parents=True, mode=0o700)
    output = ROOT / 'tests/recovery/runs' / ('restart-' + identifier) / 'report.json'
    report = {'status': 'fail', 'scope': 'Coordinated actual restart of owned PostgreSQL and loopback backend only, followed by fresh private backup/isolated restore',
              'checks': [], 'newDemoInvoked': False, 'realMoneySpent': 0}
    console = None
    try:
        console = console_owner()
        postgres = host.owned_postgres()
        active = host.execute(['docker', 'exec', host.POSTGRES, 'psql', '-U', 'agentcity', '-d', 'agentcity', '-Atqc',
                               "SELECT count(*) FROM pg_stat_activity WHERE datname='agentcity' AND pid<>pg_backend_pid() AND state='active'"], stdout=subprocess.PIPE).stdout.decode().strip()
        if active != '0':
            raise RuntimeError('An active database transaction prevents the coordinated restart.')
        results_before = console_results()
        access_before = host.access_world()
        if not access_before or not access_before[1]['State']['Running']:
            raise RuntimeError('The access world must already be running; this check will not start it.')
        others_before = container_starts()
        head_before = anvil_head()
        before = fingerprint()
        host.private_json(private / 'before.json', {'tables': before, 'console': console, 'postgresId': postgres['Id'],
                                                  'postgresStartedAt': postgres['State']['StartedAt'], 'otherContainerStarts': others_before})
        report['checks'].append('saved console PID/user/workspace and exact PostgreSQL owner/port verified; UI idle and no active database transaction')
        # The final listener check closes the PID-reuse/parallel-restart gap before signalling.
        assert console_owner()['pid'] == console['pid']
        os.kill(console['pid'], signal.SIGTERM)
        for _ in range(50):
            if not host.occupied(8789):
                break
            time.sleep(0.1)
        else:
            raise TimeoutError('Owned console did not stop; no force-kill was attempted.')
        host.execute(['docker', 'restart', '--time', '30', host.POSTGRES], stdout=subprocess.PIPE)
        started = host.execute(['python3', 'scripts/local_host.py', 'start'], stdout=subprocess.PIPE)
        health = json.loads(started.stdout)
        assert health['ready']
        independent_health = json.loads(host.execute(['python3', 'scripts/local_host.py', 'status'], stdout=subprocess.PIPE).stdout)
        assert independent_health['ready']
        renewed_console = console_owner()
        renewed_postgres = host.owned_postgres()
        assert renewed_console['pid'] != console['pid']
        assert renewed_postgres['Id'] == postgres['Id']
        assert renewed_postgres['State']['StartedAt'] != postgres['State']['StartedAt']
        after = fingerprint()
        host.private_json(private / 'after.json', {'tables': after, 'console': renewed_console, 'postgresStartedAt': renewed_postgres['State']['StartedAt']})
        assert before == after, 'Application table contents changed during restart.'
        assert console_results() == results_before, 'Saved local/public UI result identity changed.'
        assert container_starts() == others_before, 'An unrelated or protected container restarted.'
        assert anvil_head() == head_before
        access_after = host.access_world()
        assert access_after[1]['Id'] == access_before[1]['Id'] and access_after[1]['State']['StartedAt'] == access_before[1]['State']['StartedAt']
        report['checks'].append('actual PostgreSQL container restart and new backend PID recover every table fingerprint and saved UI result through local_host start/status')
        backup = host.backup()
        manifest = json.loads((backup / 'manifest.json').read_text())
        assert manifest['tables'] == after
        restored = host.restore_check(backup)
        assert any(table['schema'].startswith('public_testnet_') for table in after), 'Fresh snapshot must include current public testnet ledgers.'
        report['checks'].append('fresh online dump includes current public testnet ledgers; actual isolated pg_restore matches every captured table')
        report['checks'].append('Anvil head, user access-world container and all other running-container start times remain unchanged; no demo or signer action invoked')
        report.update(status='pass', beforeAndAfterFingerprintSha256=digest(before), tablesPreserved=len(before),
                      rowsPreserved=sum(int(table['rows']) for table in before), canonicalLedgerCountsBefore=ledger_counts(before),
                      canonicalLedgerCountsAfter=ledger_counts(after), uiResultsPreserved=results_before,
                      consoleBefore=console, consoleAfter=renewed_console, postgresContainerIdPreserved=True,
                      postgresStartTimeChanged=True, protectedContainerStartsPreserved=True, anvilHeadUnchanged=True,
                      accessWorldUnchanged=True, keystoresModified=False, health=independent_health,
                      freshBackupDirectory=str(backup.relative_to(ROOT)), isolatedRestore=restored)
    except Exception as error:
        report['status'] = 'fail'
        report['error'] = {'type': type(error).__name__, 'message': str(error)[:300]}
        raise
    finally:
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['sources'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ['ops/restart_recovery.py', 'scripts/local_host.py', 'ops/postgres_snapshot.mjs']}
        output.parent.mkdir(parents=True, exist_ok=False)
        output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'evidence': str(output.relative_to(ROOT))}))
    return report


if __name__ == '__main__':
    verify()
