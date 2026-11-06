from collections import Counter
import hashlib
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]


class CandidateManifestTests(unittest.TestCase):
    def test_candidate_remains_unvalidated_and_complete(self):
        manifest=json.loads((ROOT/'fixtures/candidates/redstone-compiler/calculator-candidate-v1.json').read_text())
        self.assertEqual(manifest['status'],'candidate_unvalidated')
        self.assertFalse(manifest['usable_for_funded_agreement'])
        self.assertIsNone(manifest['physical_test_results'])
        positions=[tuple(p['position']) for p in manifest['placements']]
        self.assertEqual(len(positions),144)
        self.assertEqual(len(positions),len(set(positions)))
        low,high=manifest['bounds']['min'],manifest['bounds']['max']
        for pos in positions:
            self.assertTrue(all(type(v) is int and low[i]<=v<=high[i] for i,v in enumerate(pos)))
        blocks={tuple(p['position']):p['block'] for p in manifest['placements']}
        self.assertEqual({i['name'] for i in manifest['inputs']},{'a0','a1','b0','b1'})
        for port in manifest['inputs']:
            self.assertEqual(blocks[tuple(port['position'])],'minecraft:lever')
        self.assertEqual(sorted(o['weight'] for o in manifest['outputs']),[1,2,4])
        for port in manifest['outputs']:
            self.assertIn(blocks[tuple(port['source_position'])],{'minecraft:redstone_torch','minecraft:redstone_wall_torch'})
            self.assertEqual(blocks[tuple(port['proposed_lamp_position'])],'minecraft:redstone_lamp')

    def test_upstream_content_and_material_accounting(self):
        manifest=json.loads((ROOT/'fixtures/candidates/redstone-compiler/calculator-candidate-v1.json').read_text())
        for source in manifest['source_files']:
            data=(ROOT/source['path']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),source['sha256'])
            self.assertEqual(hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),source['git_blob'])
        bill=Counter()
        for p in manifest['placements']:
            item={'minecraft:redstone_wire':'minecraft:redstone','minecraft:redstone_wall_torch':'minecraft:redstone_torch'}.get(p['block'],p['block'])
            bill[item]+=1
        self.assertEqual(dict(bill),manifest['proposed_material_bill'])

    def test_expected_table_is_complete_but_not_measured(self):
        manifest=json.loads((ROOT/'fixtures/candidates/redstone-compiler/calculator-tests-candidate-v1.json').read_text())
        self.assertFalse(manifest['timing_calibrated'])
        self.assertTrue(manifest['actual_lamp_observations_required'])
        self.assertEqual({(c['a'],c['b']) for c in manifest['cases']},{(a,b) for a in range(4) for b in range(4)})
        self.assertTrue(all(c['expected']==c['a']+c['b'] for c in manifest['cases']))
        self.assertEqual(sum(c['expected']>=4 for c in manifest['cases']),6)


if __name__=='__main__':unittest.main()
