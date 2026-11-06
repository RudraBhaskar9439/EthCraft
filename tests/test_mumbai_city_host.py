import importlib.util
import json
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mumbai_city_host_test', ROOT / 'scripts/mumbai_city_host.py')
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class MumbaiCityHostTests(unittest.TestCase):
    def test_exited_candidate_is_reported_without_waiting_or_connecting(self):
        with patch.object(host, 'load', return_value={'container': 'fixture'}), \
                patch.object(host, 'isolated_owned', return_value={'State': {'Running': False}}), \
                patch.object(host.mumbai, 'native') as native, patch.object(host.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'owned_candidate_exited'):
                host.ready(Path('/unused'), 25997, {'worldUuid': 'fixture'}, 'fixture', 'fixture')
            native.assert_not_called()
            sleep.assert_not_called()

    def test_port_probe_reuses_closed_connections_but_refuses_a_real_listener(self):
        factory = socket.socket
        observed = []
        with factory() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]

            class Probe:
                def __enter__(self):
                    self.socket = factory()
                    return self

                def __exit__(self, *_):
                    self.socket.close()

                def setsockopt(self, *args):
                    observed.append(args)
                    self.socket.setsockopt(*args)

                def bind(self, address):
                    self.socket.bind((address[0], port))

            with patch.object(host.laptop.socket, 'socket', side_effect=Probe):
                with self.assertRaisesRegex(RuntimeError, 'unowned_occupied_port_25596'):
                    host.laptop.ports_free()
            self.assertEqual(observed, [(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)])

    def test_unowned_isolation_does_not_reach_docker(self):
        with patch.object(host.laptop.managed, 'inspect_container') as inspect:
            with self.assertRaisesRegex(RuntimeError, 'isolation_owner_changed'):
                host.isolated_owned({'owner': 'other', 'id': '1' * 32})
            inspect.assert_not_called()

    def test_changed_candidate_never_stops_host(self):
        with tempfile.TemporaryDirectory() as directory:
            jar = Path(directory) / 'candidate.jar'
            jar.write_bytes(b'new fixture, never executed')
            isolated = {'id': '1' * 32, 'pluginSha256': 'old', 'serverId': 'fixture', 'worldUuid': 'world',
                        'sourceActiveSha256': 'source', 'sourceMumbaiConfigSha256': 'config', 'sourceWorldIds': {}}
            proof = {**isolated, 'isolatedId': isolated['id'], 'owner': 'agentcity-mumbai-city-isolated-proof', 'status': 'pass'}
            with patch.object(host, 'JAR', jar), patch.object(host, 'load', side_effect=[proof, isolated]), \
                    patch.object(host, 'inputs') as inputs, patch.object(host.mumbai, 'quiesce') as stop:
                with self.assertRaisesRegex(RuntimeError, 'matching_isolated_verification_required'):
                    host.upgrade()
                inputs.assert_not_called()
                stop.assert_not_called()

    def test_copy_failure_resumes_original_host(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / 'source'
            config = source / 'plugins/AgentCity/mumbai-world.json'
            config.parent.mkdir(parents=True)
            config.write_text('{}')
            active_file = base / 'active.json'
            active_file.write_text('{}')
            active = {'runtime': str(source), 'serverId': 'fixture', 'container': 'fixture'}
            actual = {'State': {'Running': True}}
            with patch.object(host, 'BASE', base / 'city'), patch.object(host, 'ISOLATED', base / 'absent.json'), \
                    patch.object(host.laptop, 'ACTIVE', active_file), \
                    patch.object(host, 'inputs', return_value=(active, actual, source, {'worldUuid': 'world'}, {})), \
                    patch.object(host.mumbai, 'actor_running', return_value=False), \
                    patch.object(host.mumbai, 'world_ids', return_value={}), patch.object(host.socket, 'socket'), \
                    patch.object(host.mumbai, 'quiesce') as stop, patch.object(host.mumbai, 'resume') as resume, \
                    patch.object(host.shutil, 'copytree', side_effect=RuntimeError('fixture copy failure')), \
                    patch.object(host.laptop, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'fixture copy failure'):
                    host.isolate()
                stop.assert_called_once_with(active, actual)
                resume.assert_called_once_with(active, True, False)
                command.assert_not_called()

    def test_failed_upgrade_restores_plugin_and_profile_without_world_or_database_rollback(self):
        self.check_failed_upgrade(marker_migrated=False)

    def test_failed_upgrade_keeps_v2_plugin_and_stops_if_bank_marker_migrated(self):
        self.check_failed_upgrade(marker_migrated=True)

    def check_failed_upgrade(self, marker_migrated):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            runtime = base / 'native'
            plugin = runtime / 'plugins/AgentCity.jar'
            plugin.parent.mkdir(parents=True)
            plugin.write_bytes(b'original fixture plugin')
            config = runtime / 'plugins/AgentCity/mumbai-world.json'
            config.parent.mkdir()
            config.write_text('{}')
            marker = config.parent / 'unirock-bank.json'
            marker.write_text('original fixture marker')
            world = runtime / 'fixture-world.txt'
            world.write_text('original fixture blocks')
            jar = base / 'candidate.jar'
            jar.write_bytes(b'candidate fixture plugin')
            active_file = base / 'active.json'
            active = {'runtime': str(runtime), 'container': 'fixture', 'serverId': 'fixture', 'pluginSha256': host.sha(plugin)}
            original = (json.dumps(active) + '\n').encode()
            active_file.write_bytes(original)
            ids = {'fixture': 'preserved-world'}
            isolated = {'id': '1' * 32, 'sourceActiveSha256': host.sha(active_file),
                        'sourceWorldIds': ids, 'sourceMumbaiConfigSha256': host.sha(config)}
            actual = {'Id': 'fixture-container', 'State': {'Running': True}}

            def refuse_candidate(*_):
                world.write_text('candidate fixture blocks retained for reconciliation')
                if marker_migrated:
                    (config.parent / 'unirock-bank-migration-v1-v2.json').write_text('v2 fixture migration intent')
                raise RuntimeError('fixture candidate not ready')

            with patch.object(host, 'BASE', base / 'city'), patch.object(host, 'JAR', jar), \
                    patch.object(host.laptop, 'ACTIVE', active_file), patch.object(host, 'qualification', return_value=isolated), \
                    patch.object(host, 'inputs', return_value=(active, actual, runtime, {'worldUuid': 'world'}, ids)), \
                    patch.object(host.mumbai, 'actor_running', return_value=False), \
                    patch.object(host.mumbai, 'world_ids', return_value=ids), patch.object(host.mumbai, 'quiesce'), \
                    patch.object(host.mumbai, 'resume') as resume, patch.object(host, 'ready', side_effect=refuse_candidate), \
                    patch.object(host.laptop, 'ports_free'), \
                    patch.object(host.ops, 'backup', return_value=base / 'private-db-backup') as database_backup, \
                    patch.object(host.laptop.managed, 'inspect_container', return_value=actual), patch.object(host.laptop, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'forward_recovery_required' if marker_migrated else 'fixture candidate not ready'):
                    host.upgrade()
                self.assertEqual(plugin.read_bytes(), b'candidate fixture plugin' if marker_migrated else b'original fixture plugin')
                if marker_migrated:
                    self.assertTrue(json.loads(active_file.read_text())['recoveryRequired'])
                    self.assertEqual(json.loads(active_file.read_text())['pluginSha256'], host.sha(jar))
                else:
                    self.assertEqual(active_file.read_bytes(), original)
                self.assertEqual(world.read_text(), 'candidate fixture blocks retained for reconciliation')
                self.assertEqual(resume.call_count, 0 if marker_migrated else 1)
                if not marker_migrated:
                    self.assertEqual(resume.call_args.args, (active, True, False))
                database_backup.assert_called_once()
                backups = list((base / 'city/backups').iterdir())
                self.assertEqual(len(backups), 1)
                self.assertTrue((backups[0] / 'native/fixture-world.txt').is_file())
                self.assertTrue((backups[0] / 'failure.json').is_file())


if __name__ == '__main__':
    unittest.main()
