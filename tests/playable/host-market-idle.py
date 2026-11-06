"""Focused native-custody handover guard; production state is never changed."""
import importlib.util
import json
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('node_host', root / 'scripts/host_node.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
with tempfile.TemporaryDirectory(prefix='agentcity-escrow-idle-') as folder:
    runtime = Path(folder)
    plugin = runtime / 'plugins/AgentCity'
    plugin.mkdir(parents=True)
    (runtime / 'personal-agent-tasks.json').write_text('{"tasks":[]}')
    (plugin / 'task-region-locks.json').write_text('{}')
    host.ACTIVE = {'runtime': str(runtime)}
    assert host.idle()
    journal = plugin / 'inventory-escrow.jsonl'
    records = [{'kind': 'reserve', 'operationId': 'fixture-stock-operation', 'phase': 'intent'},
               {'kind': 'authority', 'operationId': 'fixture-stock-operation'}]
    journal.write_text(''.join(json.dumps(value) + '\n' for value in records))
    assert not host.idle(), 'Refreshing authority must not hide pending inventory custody'
    records.append({'kind': 'reserve', 'operationId': 'fixture-stock-operation', 'phase': 'complete'})
    journal.write_text(''.join(json.dumps(value) + '\n' for value in records))
    assert host.idle()
print('PASS pending native item custody blocks host handover until the original operation completes')
