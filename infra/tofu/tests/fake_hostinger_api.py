"""Fake da API da Hostinger atrás de um proxy HTTPS CONNECT, para testar o import sem rede.

Uso: fake_hostinger_api.py <dir-com-srv.pem-e-srv.key> <arquivo-de-porta> <arquivo-de-log>
Registra cada requisição no log; qualquer método que não seja GET responde 500.
"""
import json
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

CERT_DIR, PORT_FILE, LOG_FILE = sys.argv[1:4]

# Host existente: o plano da assinatura (24 meses) difere do declarado na configuração.
ROUTES = {
    "/api/vps/v1/virtual-machines/777": {
        "id": 777, "subscription_id": "sub1", "hostname": "devbox-1.example.com", "state": "running",
        "ipv4": [{"address": "179.198.100.144"}], "ipv6": [],
        "template": {"id": 1077}, "data_center": {"id": 17},
    },
    "/api/billing/v1/subscriptions/sub1": {"id": "sub1", "item_id": "hostingercom-vps-kvm4-usd-24m"},
    # Chave criada pelo apply parcial anterior, ainda no state.
    "/api/vps/v1/public-keys": {"data": [{"id": 123, "name": "dangus-host", "key": "ssh-ed25519 AAAA teste"}]},
    "/api/vps/v1/data-centers": [
        {"id": 17, "name": "bnu", "location": "br", "city": "São Paulo", "continent": "South America"},
    ],
}

tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(f"{CERT_DIR}/srv.pem", f"{CERT_DIR}/srv.key")
log_lock = threading.Lock()


def log(line):
    with log_lock, open(LOG_FILE, "a") as f:
        f.write(line + "\n")


class Api(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        log(f"GET {self.path}")
        body = ROUTES.get(self.path)
        self.reply(200, body) if body is not None else self.reply(404, {"error": "not found"})

    def mutate(self):
        log(f"MUTATING {self.command} {self.path}")
        self.reply(500, {"error": "mutation blocked"})

    do_POST = do_PUT = do_PATCH = do_DELETE = mutate

    def log_message(self, *args):
        pass


class Proxy(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        if self.path != "developers.hostinger.com:443":
            log(f"BLOCKED CONNECT {self.path}")
            self.send_error(403)
            return
        self.send_response(200)
        self.end_headers()
        Api(tls.wrap_socket(self.connection, server_side=True), self.client_address, self.server)
        self.close_connection = True

    def log_message(self, *args):
        pass


class Server(HTTPServer):
    def process_request(self, request, address):
        threading.Thread(target=self.finish_request, args=(request, address), daemon=True).start()


server = Server(("127.0.0.1", 0), Proxy)
with open(PORT_FILE, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
