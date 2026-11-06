"""Check scope preservation; these tests do not construct the calculator."""

import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode()).hexdigest()


class P2ScopePreservationTests(unittest.TestCase):
    def setUp(self):
        self.scope = json.loads((ROOT / 'planning/p2-mvp-scope-2026-10-29.json').read_text())
        self.cases = json.loads((ROOT / 'planning/verification.json').read_text())
        self.by_id = {case['id']: case for case in self.cases}

    def test_all_original_cases_and_semantics_remain(self):
        inventory = self.scope['retained_original_cases']
        self.assertEqual([entry['old_id'] for entry in inventory],
                         [f'P2-{number:03d}' for number in range(1, 15)])
        for entry in inventory:
            current = self.by_id[entry['new_id']]
            semantic = {key: value for key, value in current.items()
                        if key not in {'id', 'phase', 'origin_case_id'}}
            self.assertEqual(digest(semantic), entry['requirement_sha256'])
            original = {key: value for key, value in current.items()
                        if key != 'origin_case_id'}
            original.update(id=entry['old_id'], phase='P2')
            self.assertEqual(digest(original), entry['original_case_digest'])

    def test_focused_cases_do_not_replace_distributed_lease_requirement(self):
        self.assertEqual([case['id'] for case in self.cases if case['phase'] == 'P2'],
                         self.scope['local_case_ids'])
        self.assertEqual(len(self.scope['local_case_ids']), 6)
        self.assertEqual(self.scope['retained_release_qualification_mapping']['P2-010'],
                         'P9-068')
        self.assertFalse(self.scope['distributed_task_lease_verified'])
        self.assertIn('task lease', self.by_id['P9-068']['scenario'])


if __name__ == '__main__':
    unittest.main()
