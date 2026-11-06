"""Keep one local Discord identity worker available after network crashes."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/mumbai'


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    with (BASE / 'discord-supervisor.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('LOCAL_DISCORD_SUPERVISOR_ALREADY_RUNNING')
        stopped, child = False, None

        def stop(*_):
            nonlocal stopped
            stopped = True
            if child and child.poll() is None:
                child.terminate()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        script = ROOT / 'scripts/local_discord.mjs'
        node = shutil.which('node')
        if not node:
            raise SystemExit('NODE_REQUIRED')
        log = BASE / 'local_discord.log'
        log.touch(mode=0o600, exist_ok=True)
        log.chmod(0o600)
        while not stopped:
            started = time.monotonic()
            with log.open('ab') as output:
                child = subprocess.Popen([node, str(script)], cwd=ROOT,
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
            record = BASE / 'local_discord-process.json'
            temporary = record.with_suffix('.tmp')
            temporary.write_text(json.dumps({'pid': child.pid, 'supervisorPid': os.getpid(),
                'script': str(script), 'log': str(log), 'restartPolicy': 'nonzero exit, 15 seconds'}) + '\n')
            temporary.chmod(0o600)
            temporary.replace(record)
            code = child.wait()
            if stopped or code == 0:
                break
            # Never retry credentials/configuration in a tight loop.
            until = max(time.monotonic(), started + 15)
            while not stopped and time.monotonic() < until:
                time.sleep(min(0.5, until - time.monotonic()))


if __name__ == '__main__':
    main()
