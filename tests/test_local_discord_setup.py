import importlib.util
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('local_discord_setup', Path(__file__).resolve().parents[1] / 'scripts/local_discord_setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class LocalDiscordSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'project'
        self.home = Path(self.temporary.name) / 'home'
        self.options = SimpleNamespace(application_id='123456789', guild_id='234567890', privy_app_id='fixture_privy_app',
                                       origin='http://127.0.0.1:8789', server_id='fixture-server')
        self.token, self.secret = 'M' * 60, 'privy-secret-fixture-0001'

    def configure(self, answers=None):
        values = iter(answers if answers is not None else [self.token, self.secret])
        return setup.configure(self.root, self.home, self.options, ask=lambda _: next(values))

    def environment(self, secret):
        path = self.home / 'private/import.env'
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(f'DISCORD_APPLICATION_ID={self.options.application_id}\nDISCORD_GUILD_ID={self.options.guild_id}\n'
                        f"PRIVY_APP_ID='{self.options.privy_app_id}'\nDISCORD_BOT_TOKEN=\"{self.token}\"\n"
                        f'PRIVY_APP_SECRET="{secret}"\nDISCORD_ORIGIN={self.options.origin}\nAGENTCITY_SERVER_ID={self.options.server_id}\n')
        path.chmod(0o600)
        options = SimpleNamespace(env_file=str(path), application_id=None, guild_id=None, privy_app_id=None, origin=None, server_id=None)
        return path, options

    def test_complete_identity_setup_is_private_and_has_no_signing_policy(self):
        result = self.configure()
        discord = json.loads(Path(result['discordSettings']).read_text())
        wallet = json.loads(Path(result['privySettings']).read_text())
        self.assertTrue(discord['enabled'])
        self.assertEqual(wallet['playerOrigin'], self.options.origin)
        self.assertNotIn('origin', wallet)
        for path in [Path(result['discordSettings']), Path(result['privySettings']), Path(discord['credentialsFile']), Path(wallet['credentialsFile'])]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(json.loads(Path(discord['credentialsFile']).read_text()), {'botToken': self.token})
        self.assertEqual(json.loads(Path(wallet['credentialsFile']).read_text()), {'appSecret': self.secret})
        self.assertNotIn(self.secret, Path(result['discordSettings']).read_text() + Path(result['privySettings']).read_text())
        self.assertFalse((self.root / '.local/playable-testnet/market.json').exists())

    def test_incomplete_secret_writes_no_settings_or_credentials(self):
        with self.assertRaises(ValueError):
            self.configure([self.token, ''])
        self.assertFalse((self.root / '.local/discord/settings.json').exists())
        self.assertFalse((self.root / '.local/playable-testnet/wallet-settings.json').exists())
        self.assertFalse((self.home / '.config/agentcity').exists())

    def test_compatible_reuse_preserves_keys_and_refuses_replacement(self):
        result = self.configure()
        wallet = json.loads(Path(result['privySettings']).read_text())
        private = Path(wallet['credentialsFile'])
        value = json.loads(private.read_text())
        value.update(delegateAuthorizationPrivateKey='fixture-delegate', ownerPublicKey='fixture-owner')
        private.write_text(json.dumps(value)); private.chmod(0o600)
        wallet['origin'] = 'https://legacy-unused.example'
        Path(result['privySettings']).write_text(json.dumps(wallet))
        before = private.read_bytes()
        self.configure(['', ''])
        self.assertEqual(private.read_bytes(), before)
        self.assertEqual(json.loads(Path(result['privySettings']).read_text())['origin'], wallet['origin'])
        with self.assertRaisesRegex(ValueError, 'never replaces'):
            self.configure(['N' * 60, self.secret])
        self.assertEqual(private.read_bytes(), before)
        self.options.privy_app_id = 'another_privy_app'
        with self.assertRaisesRegex(ValueError, 'incompatible'):
            self.configure()

    def test_incompatible_current_player_origin_is_refused(self):
        result = self.configure()
        path = Path(result['privySettings'])
        wallet = json.loads(path.read_text())
        wallet['playerOrigin'] = 'https://another-host.example'
        path.write_text(json.dumps(wallet))
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'incompatible'):
            self.configure(['', ''])
        self.assertEqual(path.read_bytes(), before)

    def test_last_settings_failure_rolls_back_fresh_files(self):
        replace = setup.os.replace
        def fail_discord(source, destination):
            if Path(destination) == self.root / '.local/discord/settings.json':
                raise OSError('fixture final publish failure')
            return replace(source, destination)
        with patch.object(setup.os, 'replace', side_effect=fail_discord):
            with self.assertRaisesRegex(OSError, 'fixture final publish failure'):
                self.configure()
        for relative in ['.local/discord/settings.json', '.local/playable-testnet/wallet-settings.json']:
            self.assertFalse((self.root / relative).exists())
        self.assertFalse((self.home / '.config/agentcity/discord/bot.json').exists())
        self.assertFalse((self.home / '.config/agentcity/privy/identity.json').exists())

    def test_private_environment_import_reuses_canonical_setup(self):
        path, options = self.environment(self.secret)
        inactive_token = 'Z' * 60
        with path.open('a') as output:
            output.write('DISCORD_AGENT1_APPLICATION_ID=456789012\nDISCORD_AGENT1_BOT_TOKEN=' + inactive_token + '\n')
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'mode600'):
            setup.read_private_env(path)
        path.chmod(0o600)
        result = setup.configure_from_env(self.root, self.home, options)
        discord = json.loads(Path(result['discordSettings']).read_text())
        wallet = json.loads(Path(result['privySettings']).read_text())
        self.assertEqual(discord['applicationId'], self.options.application_id)
        self.assertEqual(json.loads(Path(discord['credentialsFile']).read_text())['botToken'], self.token)
        self.assertEqual(json.loads(Path(wallet['credentialsFile']).read_text())['appSecret'], self.secret)
        self.assertEqual(wallet['playerOrigin'], self.options.origin)
        self.assertIn(inactive_token, path.read_text())
        self.assertNotIn(inactive_token, json.dumps(result) + Path(discord['credentialsFile']).read_text() + Path(result['discordSettings']).read_text())

    def test_environment_blanks_are_refused_and_shell_text_is_literal(self):
        path, options = self.environment('')
        with self.assertRaisesRegex(ValueError, 'PRIVY_APP_SECRET'):
            setup.configure_from_env(self.root, self.home, options)
        marker = self.home / 'shell-must-not-run'
        expression = '$(touch ' + str(marker) + ')'
        path, options = self.environment(expression)
        self.assertEqual(setup.read_private_env(path)['PRIVY_APP_SECRET'], expression)
        with self.assertRaises(ValueError):
            setup.configure_from_env(self.root, self.home, options)
        self.assertFalse(marker.exists())
        self.assertFalse((self.root / '.local/discord/settings.json').exists())


if __name__ == '__main__':
    unittest.main()
