"""Check planning consistency, source integrity and local documentation links."""

import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote

from check_phase import ROOT, case_digest


def main():
    phases = json.loads((ROOT/'planning/phases.json').read_text())
    cases = json.loads((ROOT/'planning/verification.json').read_text())
    phase_ids = [p['id'] for p in phases]
    scope = json.loads((ROOT/'planning/scope.json').read_text())['shared_implementation_paths']
    assert scope and all(isinstance(p,str) and p and not Path(p).is_absolute() and '..' not in Path(p).parts for p in scope)
    assert phase_ids == [f'P{i}' for i in range(11)], 'phase sequence changed without a reviewed plan update'
    ids = [c['id'] for c in cases]
    assert len(ids) == len(set(ids)), 'duplicate verification ID'
    counts = {}
    for i, phase in enumerate(phases):
        pid = phase['id']
        assert phase['dependencies'] == ([] if i == 0 else [phase_ids[i-1]])
        assert phase['implementation_paths'] and phase['build'] and phase['verify'] and phase['gate']
        subset = [c for c in cases if c['phase'] == pid]
        counts[pid] = len(subset)
        assert subset and [c['id'] for c in subset] == [f'{pid}-{j:03d}' for j in range(1,len(subset)+1)]
        record = json.loads((ROOT/f'evidence/{pid}.json').read_text())
        assert record['phase'] == pid
        assert set(record['cases']) == {c['id'] for c in subset}
        for case in subset:
            assert record['cases'][case['id']]['case_digest'] == case_digest(case), f'{case["id"]}: changed case needs renewed evidence'
            assert record['cases'][case['id']]['status'] in {'not_run','pass','fail','blocked'}
    for case in cases:
        assert case['phase'] in phase_ids
        assert case['scenario'] and case['expected'] and case['coverage_rule']
        assert case['method'] in {'Manual','Unit','Integration','Property','In-world','Fault injection'}
        assert case['priority'] in {'Critical','High','Normal'}
        assert type(case['minimum_subcases']) is int and case['minimum_subcases'] >= 1
        assert (ROOT/case['source']['document']).is_file()
    migration_path=ROOT/'planning/gate-migration-2026-10-29.json'
    if migration_path.exists():
        migration=json.loads(migration_path.read_text())
        assert migration['unchanged_total_scenarios']==len(migration['case_inventory'])
        assert len(migration['case_inventory'])<=len(cases)
        by_id={c['id']:c for c in cases}
        assert {x['new_id'] for x in migration['case_inventory']}<=set(ids)
        assert len({x['old_id'] for x in migration['case_inventory']})==len(migration['case_inventory'])
        for entry in migration['case_inventory']:
            case=by_id[entry['new_id']]
            semantic={k:v for k,v in case.items() if k not in {'id','phase','origin_case_id'}}
            digest=hashlib.sha256(json.dumps(semantic,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
            assert digest==entry['requirement_sha256'], f'{entry["new_id"]}: migrated requirement changed'
    sources = json.loads((ROOT/'planning/source-manifest.json').read_text())
    for source in sources['sources']:
        assert hashlib.sha256((ROOT/source['path']).read_bytes()).hexdigest() == source['sha256'], 'source changed'
    upstreams = json.loads((ROOT/'planning/upstreams.json').read_text())['entries']
    assert len({u['name'] for u in upstreams}) == len(upstreams)
    for upstream in upstreams:
        assert upstream['url'].startswith('https://github.com/')
        assert re.fullmatch(r'[0-9a-f]{40}',upstream['verified_revision'])
        assert upstream['use_mode'] and upstream['license'] and upstream['limitations']
    summary = json.loads((ROOT/'planning/summary.json').read_text())
    assert summary['scenario_count'] == len(cases) and summary['counts_by_phase'] == counts
    matrix = (ROOT/'docs/VERIFICATION_MATRIX.md').read_text()
    assert set(re.findall(r'\bP\d+-\d{3}\b',matrix)) == set(ids), 'verification document is incomplete'
    for path in [ROOT/'README.md',ROOT/'AGENTS.md',*ROOT.glob('docs/*.md')]:
        for target in re.findall(r'\]\(([^)]+)\)',path.read_text()):
            if '://' in target or target.startswith(('#','mailto:')):
                continue
            destination = (path.parent/unquote(target.split('#')[0])).resolve()
            assert destination.is_relative_to(ROOT), f'outside link in {path.name}'
            assert destination.exists(), f'broken link in {path.name}: {target}'
    print(f'Planning integrity PASS: {len(phases)} phases, {len(cases)} scenario families, {len(upstreams)} upstreams. No product tests executed by this check.')


if __name__ == '__main__':
    main()
