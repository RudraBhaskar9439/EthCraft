"""Preflight regression checks; these never count as in-world acceptance."""

import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate_runtime', HERE / 'run_candidate.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class CandidatePlanTests(unittest.TestCase):
    def test_all_256_source_target_pairs_are_preserved(self):
        plan = runtime.plan('native_engine', 'transitions')
        pairs = [(row['from_a'], row['from_b'], row['a'], row['b'])
                 for suite in plan['suites'] for row in suite['cases']]
        self.assertEqual(len(pairs), 256)
        self.assertEqual(set(pairs), {(fa, fb, a, b) for fa in range(4) for fb in range(4)
                                     for a in range(4) for b in range(4)})
        self.assertEqual(len(plan['suites']), 16)
        self.assertTrue(all(len(suite['cases']) == 16 for suite in plan['suites']))

    def test_orders_match_frozen_coverage_including_alternating_sum_order(self):
        coverage = json.loads((runtime.ROOT / 'tests/inspection/coverage.json').read_text())
        family = next(case for case in coverage['cases'] if case['case_id'] == 'P1-005')
        expected = {variant['parameters']['order_name']: [(row['a'], row['b']) for row
                    in variant['parameters']['ordered_inputs']]
                    for variant in family['variants']
                    if variant['parameters']['timing_profile'] == 'normal'}
        names = {'normal': 'ascending', 'descending': 'descending',
                 'alternating': 'alternating_high_low', 'seeded-20261029': 'seeded_shuffle'}
        plan = runtime.plan('native_engine', 'orders')
        for suite in plan['suites']:
            self.assertEqual([(row['a'], row['b']) for row in suite['cases']], expected[names[suite['name']]])

    def test_fault_removes_the_source_and_preserves_the_actual_lamp(self):
        plan = runtime.plan('native_engine', 'fault-repair')
        carry_output = next(output for output in plan['outputs'] if output['weight'] == 4)
        self.assertEqual(plan['carry_source']['position'], carry_output['source_position'])
        self.assertNotEqual(plan['carry_source']['position'], carry_output['proposed_lamp_position'])
        self.assertEqual(plan['carry_source']['block'], 'minecraft:redstone_wall_torch')
        faulty = plan['suites'][1]
        failures = {(row['a'], row['b']) for row in faulty['cases']
                    if row['expected_observed'] != row['expected']}
        self.assertEqual(failures, {(1, 3), (2, 2), (2, 3), (3, 1), (3, 2), (3, 3)})
        self.assertEqual(faulty['expected_pass_count'], 10)
        self.assertEqual([suite['mutation'] for suite in plan['suites']],
                         ['none', 'remove_carry', 'restore_carry'])

    def test_reserved_or_public_port_is_rejected_before_any_runtime_action(self):
        for port in [0, 25565, 25578, 65535]:
            with self.subTest(port=port), self.assertRaises(AssertionError):
                runtime.run('native_engine', 'normal', port)

    def test_excessive_delay_requires_an_explicit_incomplete_observation(self):
        plan = runtime.plan('native_engine', 'normal', 'candidate_excessive_observation_delay')
        self.assertEqual(plan['expected_inspection_status'], 'incomplete')
        self.assertEqual(plan['observation_delay_ms'], 16000)
        with self.assertRaises(ValueError):
            runtime.plan('native_engine', 'orders', 'candidate_excessive_observation_delay')


if __name__ == '__main__':
    unittest.main()
