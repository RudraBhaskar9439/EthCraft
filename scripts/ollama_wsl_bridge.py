"""Loopback-only WSL access to the existing Windows loopback Ollama service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        if (self.command, self.path) not in {('GET', '/api/tags'), ('POST', '/api/chat')}:
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 131072:
                self.send_error(413)
                return
            arguments = ['/mnt/c/Windows/System32/curl.exe', '--fail', '--silent', '--show-error',
                         '--max-time', '55', '--request', self.command, '--header', 'Content-Type: application/json',
                         'http://127.0.0.1:11434' + self.path]
            body = self.rfile.read(size)
            if self.command == 'POST':
                arguments += ['--data-binary', '@-']
            result = subprocess.run(arguments, input=body, capture_output=True, timeout=60)
            if result.returncode or len(result.stdout) > 131072:
                self.send_error(502)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result.stdout)))
            self.end_headers()
            self.wfile.write(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            self.send_error(502)

    do_GET = forward
    do_POST = forward


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 11434), Handler).serve_forever()
