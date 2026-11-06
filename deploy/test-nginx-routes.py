"""Exercise the actual proxy config with isolated ports and a synthetic upstream."""
import http.client
import http.server
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(self.path.encode())

    do_PUT = do_GET
    do_DELETE = do_GET
    do_POST = do_GET

    def log_message(self, *_args):
        pass


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ProxyRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="granttap-proxy-test-")
        cls.root = pathlib.Path(cls.temp.name)
        os.chmod(cls.root, 0o755)
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = unused_port()
        redirect_port = unused_port()
        source = pathlib.Path(sys.argv[1]).read_text()
        # Only transport bindings change: location/auth/rate/body policies stay intact.
        source = re.sub(r"listen (?:\[::\]:)?80;", f"listen 127.0.0.1:{redirect_port};", source)
        source = re.sub(r"listen (?:\[::\]:)?443 ssl(?: http2)?;", f"listen 127.0.0.1:{cls.port};", source)
        source = re.sub(r"^\s*ssl_certificate(?:_key)? .*;", "", source, flags=re.M)
        source = source.replace("127.0.0.1:3201", f"127.0.0.1:{cls.upstream.server_port}")
        source = re.sub(r"error_log /[^;]+;", f"error_log {cls.root}/error.log;", source)
        # Collapse duplicate IPv4/IPv6 listener substitutions in each server.
        source = re.sub(r"(listen 127\.0\.0\.1:\d+;)\s*\1", r"\1", source)
        config = cls.root / "nginx.conf"
        config.write_text(f"pid {cls.root}/nginx.pid;\nerror_log {cls.root}/error.log;\n"
                          "events {}\nhttp {\naccess_log off;\n"
                          "map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n"
                          + source + "\n}\n")
        binary = os.environ.get("GRANTTAP_NGINX_BIN") or shutil.which("nginx")
        if not binary:
            raise RuntimeError("A real nginx binary is required for this deployment check")
        cls.startup = (cls.root / "startup.log").open("w+")
        cls.process = subprocess.Popen([binary, "-p", str(cls.root), "-c", str(config), "-g", "daemon off;"],
                                       stdout=subprocess.DEVNULL, stderr=cls.startup)
        cls.addClassCleanup(cls.cleanup)
        for _ in range(100):
            if cls.process.poll() is not None:
                cls.startup.seek(0)
                raise RuntimeError(cls.startup.read())
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.02)
        raise RuntimeError("Isolated nginx did not become ready")

    @classmethod
    def cleanup(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.startup.close()
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.thread.join(timeout=5)
        cls.temp.cleanup()

    def request(self, path, method="GET", auth=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        headers = {"Host": "relay.granttap.com"}
        if auth:
            headers["Authorization"] = "Bearer " + "a" * 64
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, response.read().decode()
        except http.client.RemoteDisconnected:
            return 444, ""
        finally:
            connection.close()

    def test_activity_routes_reach_upstream_with_exact_method_and_query(self):
        for method, name in [("PUT", "register"), ("DELETE", "register"),
                             ("GET", "subscriptions"), ("POST", "update")]:
            path = f"/push/activity/{name}?room=synthetic"
            with self.subTest(method=method, path=path):
                self.assertEqual(self.request(path, method), (200, path))

    def test_unknown_activity_routes_and_missing_auth_stay_closed(self):
        for path in ["/push/activity/register", "/push/activity/subscriptions", "/push/activity/update"]:
            self.assertEqual(self.request(path, auth=False)[0], 444)
        for path in ["/push/activity/unknown", "/push/activity/register/extra"]:
            self.assertEqual(self.request(path)[0], 444)

    def test_existing_push_and_websocket_routes_still_reach_upstream(self):
        for path in ["/push/status?room=synthetic", "/push/register?room=synthetic", "/ws"]:
            self.assertEqual(self.request(path), (200, path))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 deploy/test-nginx-routes.py deploy/nginx-relay.conf")
    unittest.main(argv=[sys.argv[0]], verbosity=2)
