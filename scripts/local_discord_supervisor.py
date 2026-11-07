"""Keep the local Discord or existing finite-stock merchant worker available."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/mumbai'
WORKERS = {
    'discord': ('local_discord', ['scripts/local_discord.mjs'], False),
    'merchant': ('mumbai_merchant', ['scripts/mumbai_merchant.mjs', '--run'], True),
}


def worker_settings(arguments):
    if len(arguments) > 1 or arguments and arguments[0] not in WORKERS:
        raise SystemExit('USE_DISCORD_OR_MERCHANT_ONLY')
    worker = arguments[0] if arguments else 'discord'
    return worker, WORKERS[worker]


def main():
    worker, (stem, arguments, restart_clean) = worker_settings(sys.argv[1:])
    BASE.mkdir(parents=True, exist_ok=True)
    with (BASE / (worker + '-supervisor.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('LOCAL_' + worker.upper() + '_SUPERVISOR_ALREADY_RUNNING')
        stopped, child = False, None

        def stop(*_):
            nonlocal stopped
            stopped = True
            if child and child.poll() is None:
                child.terminate()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        script = ROOT / arguments[0]
        node = shutil.which('node')
        if not node:
            raise SystemExit('NODE_REQUIRED')
        log = BASE / (stem + '.log')
        log.touch(mode=0o600, exist_ok=True)
        log.chmod(0o600)
        while not stopped:
            with log.open('ab') as output:
                child = subprocess.Popen([node, str(script), *arguments[1:]], cwd=ROOT,
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
            record = BASE / (stem + '-process.json')
            temporary = record.with_suffix('.tmp')
            temporary.write_text(json.dumps({'pid': child.pid, 'supervisorPid': os.getpid(),
                'script': str(script), 'log': str(log), 'restartPolicy': ('any' if restart_clean else 'nonzero') + ' exit, 15 seconds'}) + '\n')
            temporary.chmod(0o600)
            temporary.replace(record)
            code = child.wait()
            if stopped or code == 0 and not restart_clean:
                break
            # Never retry credentials/configuration in a tight loop.
            until = time.monotonic() + 15
            while not stopped and time.monotonic() < until:
                time.sleep(min(0.5, until - time.monotonic()))


if __name__ == '__main__':
    main()
