import importlib.util
import gzip
import json
from pathlib import Path
import tempfile
import struct
import unittest
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mumbai_host_safety', ROOT / 'scripts/mumbai_host.py')
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class MumbaiHostSafetyTests(unittest.TestCase):
    def artifact(self, directory):
        base = Path(directory)
        world = base / 'artifact' / host.WORLD
        world.mkdir(parents=True)
        identity = uuid.uuid4()
        (world / 'level.dat').write_bytes(b'fixture NBT, never loaded by these tests')
        (world / 'uid.dat').write_bytes(identity.bytes)
        jar = base / 'plugin.jar'
        jar.write_bytes(b'fixture jar, never executed')
        config = {'schema': 'agentcity.mumbai-world.v1', 'world': host.WORLD, 'worldUuid': str(identity)}
        manifest = {'artifactDirectory': str(world), 'config': config,
                    'files': {p.name: host.sha(p) for p in world.iterdir()}}
        (base / 'artifact-manifest.json').write_text(json.dumps(manifest))
        (base / 'mumbai-world.json').write_text(json.dumps(config))
        return base, world, jar

    def test_exact_artifact_is_required_without_running_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            base, world, jar = self.artifact(directory)
            with patch.object(host, 'BASE', base), patch.object(host, 'JAR', jar):
                self.assertEqual(host.inputs()[0], world)
                (world / 'extra.dat').write_bytes(b'not in manifest')
                with self.assertRaisesRegex(RuntimeError, 'file_set_changed'):
                    host.inputs()
                (world / 'extra.dat').unlink()
                (world / 'level.dat').write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'artifact_file_changed'):
                    host.inputs()

    def test_manifest_paths_cannot_escape_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            base, _, jar = self.artifact(directory)
            path = base / 'artifact-manifest.json'
            manifest = json.loads(path.read_text())
            manifest['files'] = {'../outside': 'irrelevant'}
            path.write_text(json.dumps(manifest))
            with patch.object(host, 'BASE', base), patch.object(host, 'JAR', jar):
                with self.assertRaisesRegex(RuntimeError, 'unsafe_artifact_path'):
                    host.inputs()

    def test_unowned_isolation_never_reaches_docker(self):
        for value in [{'owner': 'another-owner', 'id': '1' * 32},
                      {'owner': host.OWNER, 'id': '../' + '1' * 29}]:
            with patch.object(host.laptop.managed, 'inspect_container') as inspect:
                with self.assertRaisesRegex(RuntimeError, 'isolation_owner_changed'):
                    host.isolated_owned(value)
                inspect.assert_not_called()

    def test_copy_failure_resumes_original_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            active = {'runtime': str(Path(directory) / 'source'), 'container': 'fixture', 'serverId': 'same'}
            with patch.object(host, 'BASE', Path(directory)), patch.object(host, 'ISOLATED', Path(directory) / 'absent.json'), \
                 patch.object(host, 'inputs', return_value=(Path(directory) / 'map', {})), \
                 patch.object(host, 'load', return_value=active), \
                 patch.object(host.laptop, 'owned', return_value={'State': {'Running': True}}), \
                 patch.object(host, 'actor_running', return_value=True), \
                 patch.object(host, 'world_ids', return_value={}), \
                 patch.object(host, 'city_paths', return_value=[Path(directory) / 'absent-city']), \
                 patch.object(host.socket, 'socket'), patch.object(host, 'quiesce') as stop, \
                 patch.object(host.shutil, 'copytree', side_effect=RuntimeError('copy failed')), \
                 patch.object(host, 'resume') as resume, patch.object(host.laptop, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'copy failed'):
                    host.isolate()
                stop.assert_called_once()
                resume.assert_called_once_with(active, True, True)
                command.assert_not_called()

    def test_changed_plugin_evidence_cannot_install(self):
        with patch.object(host, 'inputs', return_value=(Path('/unused'), {'worldUuid': 'fixture'})), \
             patch.object(host, 'load', side_effect=[{'status': 'pass', 'pluginSha256': 'old'}, {'serverId': 'same'}]), \
             patch.object(host, 'sha', return_value='new'), patch.object(host.laptop, 'owned') as owned, \
             patch.object(host, 'quiesce') as stop:
            with self.assertRaisesRegex(RuntimeError, 'matching_isolated_verification_required'):
                host.install()
            owned.assert_not_called()
            stop.assert_not_called()

    def test_persistent_dimension_uuid_is_read_from_actual_nbt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = uuid.uuid4()
            file = root / 'primary/dimensions/minecraft/lobby/data/paper/metadata.dat'
            file.parent.mkdir(parents=True)
            name = lambda value: struct.pack('>H', len(value)) + value.encode()
            parts = struct.unpack('>iiii', identity.bytes)
            data = (b'\x0a\x00\x00\x03' + name('DataVersion') + struct.pack('>i', 5023)
                    + b'\x0a' + name('data') + b'\x0b' + name('uuid') + struct.pack('>i', 4)
                    + struct.pack('>iiii', *parts) + b'\x00\x00')
            file.write_bytes(gzip.compress(data, mtime=0))
            self.assertEqual(host.world_ids(root), {str(file.relative_to(root)): str(identity)})
            file.unlink()
            with self.assertRaisesRegex(RuntimeError, 'no_persistent_world_identities'):
                host.world_ids(root)

    def test_preservation_requires_old_uuids_and_exactly_one_new_world(self):
        previous = {'primary/dimensions/minecraft/lobby/data/paper/metadata.dat': 'old-uuid'}
        with patch.object(host, 'world_ids', return_value={**previous, 'city-metadata': 'new-uuid'}):
            host.verify_old_world_ids(Path('/unused'), previous, 'new-uuid')
        with patch.object(host, 'world_ids', return_value={**previous, 'city-metadata': 'wrong-uuid'}):
            with self.assertRaisesRegex(RuntimeError, 'imported_world_identity_changed'):
                host.verify_old_world_ids(Path('/unused'), previous, 'new-uuid')
        with patch.object(host, 'world_ids', return_value={next(iter(previous)): 'changed', 'city-metadata': 'new-uuid'}):
            with self.assertRaisesRegex(RuntimeError, 'prior_world_identity_changed'):
                host.verify_old_world_ids(Path('/unused'), previous, 'new-uuid')


if __name__ == '__main__':
    unittest.main()
