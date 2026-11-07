"""Read-only supervisor configuration checks; no processes, game or transactions."""
import importlib.util
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest import mock

spec = importlib.util.spec_from_file_location('worker_supervisor', Path(__file__).resolve().parents[1] / 'scripts/local_discord_supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class WorkerSupervisorTests(unittest.TestCase):
    def test_default_keeps_existing_discord_command_and_clean_exit(self):
        self.assertEqual(supervisor.worker_settings([]), ('discord', ('local_discord', ['scripts/local_discord.mjs'], False)))

    def test_merchant_reconnect_never_bootstraps_new_stock(self):
        worker, (stem, command, restart_clean) = supervisor.worker_settings(['merchant'])
        self.assertEqual((worker, stem), ('merchant', 'mumbai_merchant'))
        self.assertEqual(command, ['scripts/mumbai_merchant.mjs', '--run'])
        self.assertTrue(restart_clean)
        self.assertNotIn('--bootstrap', command)

    def test_rejects_arbitrary_workers_and_extra_arguments(self):
        for arguments in [['other'], ['merchant', '--bootstrap'], ['discord', 'merchant']]:
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit):
                supervisor.worker_settings(arguments)

    def test_merchant_normal_disconnect_restarts_same_nonbootstrap_command(self):
        handlers = {}
        children = [mock.Mock(pid=111), mock.Mock(pid=222)]
        children[0].wait.return_value = 0

        def finish_second_child():
            handlers[supervisor.signal.SIGTERM]()
            return 0

        children[1].poll.return_value = None
        children[1].wait.side_effect = finish_second_child
        with TemporaryDirectory() as directory, \
                mock.patch.object(supervisor, 'BASE', Path(directory)), \
                mock.patch.object(supervisor.sys, 'argv', ['supervisor', 'merchant']), \
                mock.patch.object(supervisor.shutil, 'which', return_value='/fixture/node'), \
                mock.patch.object(supervisor.signal, 'signal', side_effect=lambda sig, fn: handlers.__setitem__(sig, fn)), \
                mock.patch.object(supervisor.time, 'monotonic', side_effect=[0, 16]), \
                mock.patch.object(supervisor.subprocess, 'Popen', side_effect=children) as start:
            supervisor.main()
            expected = ['/fixture/node', str(supervisor.ROOT / 'scripts/mumbai_merchant.mjs'), '--run']
            self.assertEqual(start.call_count, 2)
            self.assertTrue(all(call.args[0] == expected for call in start.call_args_list))
            children[1].terminate.assert_called_once()
