"""Local launcher ownership and exact rollback fixtures; never request microphone access."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('voice_setup_test', ROOT / 'scripts/voice_setup.py')
voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voice)


class VoiceLauncherTests(unittest.TestCase):
    def test_other_launcher_is_not_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / 'Other.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            info = app / 'Contents/Info.plist'
            original = plistlib.dumps({'CFBundleIdentifier': 'another.vendor.launcher'})
            info.write_bytes(original)
            (app / 'Contents/MacOS/TLauncher').write_bytes(b'other launcher')
            with patch.object(voice, 'MAC_LAUNCHER', app), patch.object(voice, 'BASE', Path(directory) / 'private'), patch.object(voice, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'owned_local_tlauncher_wrapper_required'):
                    voice.mac_permissions()
                run.assert_not_called()
            self.assertEqual(info.read_bytes(), original)

    def test_signing_failure_restores_existing_launcher_and_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / 'private'
            base.mkdir()
            app = Path(directory) / 'TLauncher.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            info = app / 'Contents/Info.plist'
            original_info = plistlib.dumps({'CFBundleIdentifier': 'local.tlauncher.launcher'})
            original_executable = b'previous owned native launcher fixture'
            info.write_bytes(original_info)
            executable = app / 'Contents/MacOS/TLauncher'
            executable.write_bytes(original_executable)
            signature = app / 'Contents/_CodeSignature/CodeResources'
            signature.parent.mkdir(); signature.write_bytes(b'previous signature')
            (base / 'mac-launcher.json').write_text(json.dumps({'executableSha256': hashlib.sha256(original_executable).hexdigest()}))
            def run(args, **_):
                if args[0] == 'xcrun': Path(args[-1]).write_bytes(b'new native launcher fixture')
                else:
                    signature.write_bytes(b'failed candidate signature')
                    raise subprocess.CalledProcessError(1, args)
            with patch.object(voice, 'MAC_LAUNCHER', app), patch.object(voice, 'BASE', base), patch.object(voice, 'run', side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError): voice.mac_permissions()
            self.assertEqual(info.read_bytes(), original_info)
            self.assertEqual(executable.read_bytes(), original_executable)
            self.assertEqual(signature.read_bytes(), b'previous signature')


if __name__ == '__main__': unittest.main()
