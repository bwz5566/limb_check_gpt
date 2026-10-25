"""A real local HTTP exchange with synthetic output, not an accuracy test."""
import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from backend.config import load_config
from backend.vlm import review


class TransportTests(unittest.TestCase):
    def test_openai_compatible_round_trip_and_no_client_prompt(self):
        observed = {}

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                observed['path'] = self.path
                observed['auth'] = self.headers.get('Authorization')
                observed['body'] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                response = {'choices': [{'message': {'content': json.dumps({'checks': {'fingers': {'status': 'uncertain', 'reason': 'synthetic fixture', 'confidence': .95}}})}}]}
                raw = json.dumps(response).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def log_message(self, *args): pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            config = load_config('test')
            config['vlm'].update(enabled=True, base_url=f'http://127.0.0.1:{server.server_port}/v1', model='test-only-model', api_key='test-only-key')
            raw = (Path(__file__).resolve().parent.parent/'samples/blank.png').read_bytes()
            image = 'data:image/png;base64,' + base64.b64encode(raw).decode()
            response = review(config, {'consent': True, 'checks': ['fingers'], 'images': [image], 'prompt': 'UNTRUSTED_CLIENT_PROMPT'})
            self.assertEqual(response['checks']['fingers']['status'], 'uncertain')
            self.assertFalse(response['effect_validated'])
            self.assertEqual(observed['path'], '/v1/chat/completions')
            self.assertEqual(observed['auth'], 'Bearer test-only-key')
            self.assertNotIn('UNTRUSTED_CLIENT_PROMPT', json.dumps(observed['body']))
            self.assertNotIn('test-only-key', json.dumps(response))
            self.assertEqual(observed['body']['messages'][0]['content'][1]['image_url']['url'], image)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
