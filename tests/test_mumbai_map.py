import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mumbai_map', ROOT / 'scripts/mumbai_map.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MumbaiMapTests(unittest.TestCase):
    def test_district_and_command_keep_vanilla_secondary_world_safe(self):
        config = MODULE.configuration()
        command = MODULE.generation_command(config, Path('/generator'), Path('/worlds'))
        for flag in ['--signage=none', '--map-item=false', '--vanilla-height', '--mapillary-facades=false']:
            self.assertIn(flag, command)
        self.assertNotIn('--building-facades', command)
        self.assertEqual(config['world'], 'agentcity_mumbai')

    def test_oversized_and_invalid_coordinates_refused_before_download(self):
        valid = MODULE.configuration()
        for bounds in [[0, 0, 90, 180], [20, 72, 18, 73], [float('nan'), 72, 19, 73]]:
            config = copy.deepcopy(valid)
            config['bbox'] = bounds
            with patch.object(MODULE.json, 'loads', return_value=config):
                with self.assertRaises(ValueError):
                    MODULE.configuration()


if __name__ == '__main__':
    unittest.main()
