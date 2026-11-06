"""Exercise the deployment checker against a local aggregate-health endpoint."""
import http.server
import json
import pathlib
import subprocess
import sys
import threading
import unittest


class AuxiliaryReadinessCommandTests(unittest.TestCase):
    """Check availability, strict compatibility, and legacy response handling."""

    def check_command(self, check, strict=False):
        """Serve a supplied health check and return the checker process result."""
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"checks": {} if check is None else {"auxiliaryModels": check}}).encode())

            def log_message(self, *_):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        script = pathlib.Path(__file__).resolve().parents[2] / "scripts/check-auxiliary-readiness.py"
        try:
            return subprocess.run([sys.executable, str(script), f"http://127.0.0.1:{server.server_port}", *(["--require-probes"] if strict else [])], capture_output=True, text=True, timeout=10)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_verified_chain_passes(self):
        self.assertEqual(self.check_command({"status": "pass"}, strict=True).returncode, 0)

    def test_unavailable_chain_fails(self):
        self.assertEqual(self.check_command({"status": "fail"}).returncode, 1)

    def test_unverified_chain_requires_explicit_strictness(self):
        self.assertEqual(self.check_command({"status": "skip"}).returncode, 0)
        self.assertEqual(self.check_command({"status": "skip"}, strict=True).returncode, 1)

    def test_legacy_app_does_not_claim_readiness(self):
        self.assertEqual(self.check_command(None).returncode, 1)


if __name__ == "__main__":
    unittest.main()
