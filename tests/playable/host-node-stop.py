"""Real isolated tmux supervisor/child shutdown; never touches production sessions."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

root = Path('/mnt/c/Users/Rudransh Shinghal/agentcity-minecraft')
spec = importlib.util.spec_from_file_location('node_host', root / 'scripts/host_node.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
socket = 'agentcity-stop-fixture-' + uuid.uuid4().hex
original_node = host.NODE
with tempfile.TemporaryDirectory(prefix='agentcity-stop-') as folder:
    fixture = Path(folder)
    base = fixture / '.local/hosting'
    base.mkdir(parents=True)
    (base / 'enabled').touch()
    scripts = fixture / 'scripts'
    scripts.mkdir()
    (scripts / 'playable_rpc_dns.cjs').write_text('')
    app = fixture / 'backend/src/discord/public-gateway.mjs'
    app.parent.mkdir(parents=True)
    app.write_text("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)\n")
    wrapper = scripts / 'host_node.py'
    wrapper.write_text('import importlib.util\nfrom pathlib import Path\n'
        + 's=importlib.util.spec_from_file_location("real_host",'+repr(str(root / 'scripts/host_node.py'))+')\n'
        + 'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
        + 'm.ROOT=Path('+repr(folder)+');m.BASE=m.ROOT/".local/hosting";m.STATE=m.BASE/"state.json"\n'
        + 'm.run("gateway")\n')
    def tmux(*args, check=True):
        return subprocess.run(['tmux', '-L', socket, *args], check=check, capture_output=True, text=True)
    try:
        tmux('new-session', '-d', '-s', 'agentcity-gateway', '/usr/bin/python3', str(wrapper), 'run', 'gateway')
        child_file = base / 'gateway.pid'
        for _ in range(100):
            if child_file.exists():
                break
            time.sleep(.1)
        child = int(child_file.read_text())
        assert Path('/proc', str(child)).exists()
        host.ROOT, host.BASE, host.STATE = fixture, base, base / 'state.json'
        host.tmux, host.idle = tmux, lambda: True
        host.stop()
        time.sleep(3)
        assert not Path('/proc', str(child)).exists(), 'owned child must be reaped'
        assert not (base / 'enabled').exists(), 'disabled services must not restart'
        assert tmux('has-session', '-t', 'agentcity-gateway', check=False).returncode != 0
        print(json.dumps({'status':'pass','scope':'Isolated real tmux and Node child; production socket untouched','orphanChild':False,'serviceRespawned':False}))
    finally:
        tmux('kill-server', check=False)
