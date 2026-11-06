"""Actual opaque UDP round trip in disposable owned Docker containers, not the game."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class VoiceTransportTest(unittest.TestCase):
    def test_separate_clients_and_no_packet_recording(self):
        image = json.loads((ROOT / '.local/playable-world/active.json').read_text())['javaImage']
        suffix = uuid.uuid4().hex[:10]
        network, upstream, relay = ['voice-test-' + kind + '-' + suffix for kind in ('net', 'upstream', 'relay')]
        def docker(*args):
            return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()
        with tempfile.TemporaryDirectory(prefix='voice-transport-') as directory:
            fixture = Path(directory)
            (fixture / 'Echo.java').write_text('''import java.net.*;
public class Echo { public static void main(String[] args) throws Exception {
try (var s = new DatagramSocket(24454)) { while (true) { var p = new DatagramPacket(new byte[4096],4096); s.receive(p); s.send(p); } }
}}''')
            try:
                docker('network', 'create', '--label', 'agentcity.owner=voice-transport-test', network)
                docker('run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
                       '-v', str(fixture) + ':/test', '-v', str(ROOT / 'tools/voice') + ':/source:ro', image,
                       'javac', '--release', '25', '-d', '/test', '/source/DatagramRelay.java', '/test/Echo.java')
                for name, main in [(upstream, 'Echo'), (relay, 'DatagramRelay')]:
                    args = ['run', '-d', '--pull', 'never', '--name', name, '--label', 'agentcity.owner=voice-transport-test',
                            '--network', network, '-v', str(fixture) + ':/test:ro', '--memory', '128m']
                    if main == 'Echo': args += ['--network-alias', 'agentcity-minecraft']
                    else: args += ['-p', '127.0.0.1::24454/udp']
                    args += [image, 'java', '-Xmx32m', '-cp', '/test', main]
                    if main == 'DatagramRelay': args.append('agentcity-minecraft')
                    docker(*args)
                details = json.loads(docker('inspect', relay))[0]
                binding = details['NetworkSettings']['Ports']['24454/udp'][0]
                self.assertEqual(binding['HostIp'], '127.0.0.1')
                address = ('127.0.0.1', int(binding['HostPort']))
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as one, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as two:
                    one.settimeout(1); two.settimeout(1)
                    for client, payload in [(one, b'private-one'), (two, b'private-two'), (one, b'one-again')]:
                        for attempt in range(10):
                            client.sendto(payload, address)
                            try:
                                self.assertEqual(client.recvfrom(4096)[0], payload); break
                            except TimeoutError:
                                if attempt == 9: raise
                    self.assertEqual(docker('logs', relay), '')
            finally:
                for name in (relay, upstream):
                    result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
                    if result.returncode == 0:
                        self.assertEqual(json.loads(result.stdout)[0]['Config']['Labels']['agentcity.owner'], 'voice-transport-test')
                        docker('rm', '-f', name)
                subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


if __name__ == '__main__': unittest.main()
