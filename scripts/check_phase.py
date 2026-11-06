"""Validate recorded phase evidence; never execute or approve product tests."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return json.loads(path.read_text())


def case_digest(case):
    return hashlib.sha256(json.dumps(case, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def artifact_errors(root, artifacts, label):
    if not isinstance(artifacts, list) or not artifacts:
        return [f'{label}: evidence is missing']
    errors = []
    for item in artifacts:
        if not isinstance(item, dict) or not isinstance(item.get('path'), str):
            errors.append(f'{label}: invalid artifact reference')
            continue
        path = (root / item['path']).resolve()
        if Path(item['path']).is_absolute() or not path.is_relative_to(root.resolve()):
            errors.append(f'{label}: artifact escapes repository')
        elif not path.is_file() or path.stat().st_size == 0:
            errors.append(f'{label}: artifact is absent or empty: {item["path"]}')
        elif hashlib.sha256(path.read_bytes()).hexdigest() != item.get('sha256'):
            errors.append(f'{label}: artifact hash mismatch: {item["path"]}')
    return errors


def release_errors(root, phase, release):
    if not isinstance(release, str) or not re.fullmatch(r'[0-9a-f]{40}', release):
        return ['release must be an exact 40 character Git commit']
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, capture_output=True, text=True)
    if git('merge-base', '--is-ancestor', release, 'HEAD').returncode:
        return ['approved release is not in the current Git history']
    shared = load(root / 'planning/scope.json')['shared_implementation_paths']
    paths = phase['implementation_paths'] + shared
    if not paths or any(not isinstance(p, str) or not p or Path(p).is_absolute() or '..' in Path(p).parts for p in paths):
        return ['invalid implementation scope']
    changed = git('diff', '--name-only', release, 'HEAD', '--', *paths)
    dirty = git('status', '--porcelain', '--', *paths)
    if changed.returncode or dirty.returncode:
        return ['cannot establish unchanged phase implementation scope']
    if changed.stdout.strip() or dirty.stdout.strip():
        return ['implementation scope changed since the approved release; review and rerun affected evidence']
    return []


def phase_errors(root, phase_id, revision_check=release_errors):
    phases = load(root / 'planning/phases.json')
    cases = load(root / 'planning/verification.json')
    by_id = {p['id']: p for p in phases}
    if phase_id not in by_id:
        return [f'unknown phase: {phase_id}']
    def inspect(pid, active):
        if pid in active:
            return [f'{pid}: dependency cycle']
        if pid not in by_id:
            return [f'unknown dependency: {pid}']
        phase = by_id[pid]
        errors = []
        for previous in phase['dependencies']:
            if inspect(previous, active | {pid}):
                errors.append(f'{previous} is not ready')
        path = root / f'evidence/{pid}.json'
        if not path.is_file():
            return errors + [f'{pid}: execution record is missing']
        record = load(path)
        if record.get('phase') != pid:
            errors.append('execution record phase mismatch')
        errors.extend(revision_check(root, phase, record.get('release')))
        if not isinstance(record.get('environment'), str) or not record['environment'].strip():
            errors.append('environment is missing')
        if record.get('open_defects') != []:
            errors.append('relevant open defects must be explicitly empty')
        review = record.get('review', {})
        if not isinstance(review, dict):
            review = {}
        if review.get('status') != 'approved' or not isinstance(review.get('reviewer'), str) or not review['reviewer'].strip():
            errors.append('approved named review is missing')
        if review.get('release') != record.get('release'):
            errors.append('review release mismatch')
        errors.extend(artifact_errors(root, review.get('evidence'), 'review'))
        expected = {c['id']: c for c in cases if c['phase'] == pid}
        actual = record.get('cases', {})
        if not isinstance(actual, dict):
            actual = {}
        if not expected or set(expected) != set(actual):
            errors.append('execution case set differs from the required case set')
        for cid, case in expected.items():
            result = actual.get(cid, {})
            if not isinstance(result, dict):
                result = {}
            if result.get('case_digest') != case_digest(case):
                errors.append(f'{cid}: case changed or digest missing')
            if result.get('status') != 'pass':
                errors.append(f'{cid}: not passed')
                continue
            errors.extend(artifact_errors(root, result.get('evidence'), cid))
            coverage = result.get('subcases', {})
            if not isinstance(coverage, dict):
                coverage = {}
            required, passed = coverage.get('required'), coverage.get('passed')
            if (type(required) is not int or type(passed) is not int
                    or required < case['minimum_subcases'] or passed != required
                    or type(coverage.get('failed')) is not int or coverage['failed'] != 0
                    or type(coverage.get('blocked')) is not int or coverage['blocked'] != 0):
                errors.append(f'{cid}: required subcases are incomplete')
        return errors
    return inspect(phase_id, set())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase')
    args = parser.parse_args()
    try:
        errors = phase_errors(ROOT, args.phase)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors = [f'invalid planning or evidence data: {exc}']
    if errors:
        print(f'{args.phase}: BLOCKED')
        for error in errors[:15]:
            print('- '+error)
        if len(errors) > 15:
            print(f'- {len(errors)-15} additional unmet conditions')
        return 1
    print(f'{args.phase}: READY for its approved unchanged implementation scope')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
