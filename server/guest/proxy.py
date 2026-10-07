#!/usr/bin/env python3
"""On-demand guest egress. Private JSON stdin; metadata-only JSON stdout.

Own nftables table intercepts host IPv4 TCP and DNS, and blocks other egress.
The relay uses marked sockets restricted to the resolved proxy gateway. Boat's
inbound replies and existing WireGuard endpoint remain on their normal route.
No TLS interception; CONNECT tunnel payload bytes are counted in both directions.
"""
import base64
import contextlib
import fcntl
import http.client
import ipaddress
import json
import os
import pathlib
import re
import stat
import signal
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = pathlib.Path('/var/lib/tameduck-proxy')
CONFIG = ROOT / 'config.json'
STATE = ROOT / 'state.json'
CONTROL = '/run/tameduck-proxy.sock'
UNIT = 'tameduck-proxy.service'
TABLE = 'tameduck_proxy'
MARK = 0x544450
CONTROL_MARK = 0x544451
CONTROL_CONFIG = pathlib.Path('/var/lib/tameduck-control/endpoint.json')
PROVIDER_CONFIG = pathlib.Path('/var/lib/ascii-lazy/config.json')
PROVIDER_EXE = pathlib.Path('/opt/ascii-agent/ascii-lazyfs')
CGROUP_ROOT = pathlib.Path('/sys/fs/cgroup/system.slice')
RELAY_PORT, DNS_PORT = 15080, 15053
LEASE_MAX = 300
STOP = threading.Event()
LOCK = threading.RLock()
SOCKETS = set()
SESSION = {}
SETTINGS = {}
MAX_CONNECTIONS = threading.BoundedSemaphore(128)


def read_json(path, default=None):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else (default or {})
    except (OSError, ValueError):
        return default or {}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='.proxy-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        parent = os.open(path.parent, os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        with contextlib.suppress(FileNotFoundError): os.unlink(tmp)


def boot_id():
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def metadata(s):
    return {k: s.get(k, default) for k, default in {
        'session_id': None, 'enabled': False, 'status': 'disabled',
        'lease_expires_at': None, 'upload_bytes': 0, 'download_bytes': 0,
        'active_connections': 0, 'checkpoint_at': None, 'exit_ip': None,
        'boot_id': None, 'error': None, 'metering_incomplete': False,
    }.items()}


def checkpoint():
    with LOCK:
        SESSION['checkpoint_at'] = time.time()
        write_json(STATE, SESSION)
        if SESSION.get('session_id'):
            write_json(ROOT / 'sessions' / (SESSION['session_id'] + '.json'), SESSION)


def add_bytes(key, count):
    with LOCK: SESSION[key] = SESSION.get(key, 0) + count


def execute(argv, text=None, check=True):
    r = subprocess.run(argv, input=text, text=True, capture_output=True, timeout=15)
    if check and r.returncode: raise RuntimeError('network_operation_failed')
    return r


def wg_endpoints():
    result = []
    r = execute(['wg', 'show', 'all', 'endpoints'], check=False)
    if r.returncode: return result
    for line in r.stdout.splitlines():
        endpoint = line.split()[-1]
        if endpoint == '(none)': continue
        host, port = endpoint.rsplit(':', 1)
        addr = ipaddress.ip_address(host.strip('[]'))
        result.append((str(addr), int(port)))
    return result


def control_endpoint(host, port):
    if not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host):
        raise ValueError('invalid_control_host')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('invalid_control_port')
    old = read_json(CONTROL_CONFIG)
    retained = old.get('ips', []) if old.get('host') == host and old.get('port') == port else []
    try: fresh = [x[4][0] for x in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)]
    except OSError: fresh = []
    ips = list(dict.fromkeys(str(ipaddress.IPv4Address(ip)) for ip in fresh + retained))
    if not ips: raise RuntimeError('control_endpoint_unavailable')
    # Prefer the current DNS answer and retain recent prior addresses for
    # already-open relays without growing a permanent broad allowlist.
    ips = ips[:8]
    endpoint = {'host': host, 'port': port, 'ips': ips}
    write_json(CONTROL_CONFIG, endpoint)
    return endpoint


def provider_storage(config_path=PROVIDER_CONFIG, exe_path=PROVIDER_EXE,
                     cgroup_root=CGROUP_ROOT, proc_root=pathlib.Path('/proc')):
    """Exact provider cgroups and storage addresses, never URL paths or tokens."""
    try:
        executable = exe_path.stat()
        if executable.st_uid != 0 or executable.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            return {}
    except OSError:
        return {}
    services = []
    for service in cgroup_root.glob('ascii-lazyfs-*.service'):
        if not re.fullmatch(r'ascii-lazyfs-[0-9]+\.service', service.name): continue
        found = False
        for members in service.rglob('cgroup.procs'):
            try: pids = members.read_text().split()
            except OSError: continue
            for pid in pids:
                if not pid.isdecimal(): continue
                try: target = (proc_root / pid / 'exe').resolve(strict=True)
                except OSError: continue
                if target == exe_path.resolve(): found = True; break
            if found: break
        if found: services.append(service.name)
    if not services:return {}
    try:
        source = config_path.stat()
        # Boat writes this file as the guest user. Its destinations must pass
        # the provider-host check below, and the file must not be shared-writable.
        if source.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ValueError('unsafe_provider_config')
        raw = json.loads(config_path.read_text())
    except (OSError, ValueError):
        raise RuntimeError('provider_storage_unavailable') from None
    hosts = set()
    url_keys = {'manifestUrl','manifestBackupUrl','lazyIndexUrl','lazyIndexBackupUrl',
                'url','backupUrl','indexUrl','indexBackupUrl'}
    def visit(value, key=None):
        if isinstance(value, dict):
            for name, child in value.items(): visit(child, name)
        elif isinstance(value, list):
            for child in value: visit(child, key)
        elif key in url_keys and isinstance(value, str):
            from urllib.parse import urlsplit
            try:
                parsed = urlsplit(value)
                provider_host = parsed.hostname == 'boat.dev' or bool(re.fullmatch(
                    r'(?:ascii-snapshots(?:-[0-9]+)?|snapshots-backup-[0-9]+|[0-9]+)\.'
                    r'[a-z0-9-]+\.your-objectstorage\.com', parsed.hostname or ''))
                if parsed.scheme == 'https' and provider_host and (parsed.port or 443) == 443:
                    hosts.add(parsed.hostname)
            except ValueError: pass
    visit(raw)
    if not hosts: raise RuntimeError('provider_storage_unavailable')
    v4, v6 = set(), set()
    for host in hosts:
        try: addresses = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
        except OSError: raise RuntimeError('provider_storage_unavailable') from None
        if not addresses: raise RuntimeError('provider_storage_unavailable')
        for address in addresses:
            try: ip = ipaddress.ip_address(address[4][0])
            except (IndexError, ValueError):
                raise RuntimeError('provider_storage_unavailable') from None
            (v4 if ip.version == 4 else v6).add(str(ip))
    return {'provider_cgroups': sorted(services),
            'provider_v4': sorted(v4), 'provider_v6': sorted(v6)}


def rules(config):
    # This is one atomic nft transaction, ahead of existing UFW/Docker rules.
    # No global ruleset flush and no arbitrary UID/root exemption.
    gateways = ', '.join(str(ipaddress.IPv4Address(x)) for x in config['gateway_ips'])
    port = int(config['proxy_port'])
    control_ips = ', '.join(str(ipaddress.IPv4Address(x)) for x in config.get('control_ips', []))
    control_port = int(config.get('control_port', 0))
    base = [f'add table inet {TABLE}',
            f'add chain inet {TABLE} route {{ type nat hook output priority -110; policy accept; }}',
            f'add chain inet {TABLE} guard {{ type filter hook output priority -10; policy accept; }}',
            f'add chain inet {TABLE} forward_guard {{ type filter hook forward priority -10; policy accept; }}']
    n = f'add rule inet {TABLE} route '
    g = f'add rule inet {TABLE} guard '
    base += [n + 'ct direction reply return',
             n + f'meta mark {MARK} ip daddr {{ {gateways} }} tcp dport {port} return',
             *([n + f'meta mark {CONTROL_MARK} ip daddr {{ {control_ips} }} tcp dport {control_port} counter return'] if control_ips else []),
             n + f'meta nfproto ipv4 udp dport 53 redirect to :{DNS_PORT}',
             n + f'meta nfproto ipv4 tcp dport 53 redirect to :{DNS_PORT}',
             n + 'ip daddr 127.0.0.0/8 return',
             n + f'meta nfproto ipv4 meta l4proto tcp redirect to :{RELAY_PORT}',
             g + 'ct direction reply accept',
             # OUTPUT REDIRECT changes destination before the kernel recalculates
             # the outgoing interface. oif can still be the old ethernet here.
             g + 'ip daddr 127.0.0.0/8 accept',
             g + 'ip6 daddr ::1 accept',
             g + 'oifname "lo" accept',
             g + f'meta mark {MARK} ip daddr {{ {gateways} }} tcp dport {port} accept',
             *([g + f'meta mark {CONTROL_MARK} ip daddr {{ {control_ips} }} tcp dport {control_port} counter accept'] if control_ips else [])]
    for service in config.get('provider_cgroups', []):
        if not re.fullmatch(r'ascii-lazyfs-[0-9]+\.service', service): raise ValueError('invalid_provider_cgroup')
        for family, addresses in [('ip', config.get('provider_v4', [])),
                                  ('ip6', config.get('provider_v6', []))]:
            if not addresses: continue
            values = ', '.join(str(ipaddress.ip_address(ip)) for ip in addresses)
            if family == 'ip':
                base.insert(base.index(n + f'meta nfproto ipv4 udp dport 53 redirect to :{DNS_PORT}'),
                            n + f'socket cgroupv2 level 2 "system.slice/{service}" ip daddr {{ {values} }} tcp dport 443 counter return')
            base.append(g + f'socket cgroupv2 level 2 "system.slice/{service}" {family} daddr {{ {values} }} tcp dport 443 counter accept')
    for host, wg_port in config.get('wireguard_endpoints', []):
        addr = ipaddress.ip_address(host)
        family = 'ip' if addr.version == 4 else 'ip6'
        base.append(g + f'{family} daddr {addr} udp dport {int(wg_port)} accept')
    # Required to retain IPv6 Boat management connectivity, not application data.
    base += [g + 'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert } accept',
             g + 'reject with icmpx type admin-prohibited',
             # Forwarded/container egress cannot silently bypass host interception.
             f'add rule inet {TABLE} forward_guard ct direction reply accept',
             f'add rule inet {TABLE} forward_guard reject with icmpx type admin-prohibited']
    return '\n'.join(base) + '\n'


def remove_rules():
    r = execute(['nft', 'list', 'table', 'inet', TABLE], check=False)
    if r.returncode == 0: execute(['nft', 'delete', 'table', 'inet', TABLE])


def install_rules(config):
    script = rules(config)
    # Replace our table atomically on daemon recovery, keeping existing guard up.
    if execute(['nft', 'list', 'table', 'inet', TABLE], check=False).returncode == 0:
        script = f'delete table inet {TABLE}\n' + script
    execute(['nft', '-c', '-f', '-'], script)
    execute(['nft', '-f', '-'], script)


def auth_header(config):
    return base64.b64encode((config['username'] + ':' + config['password']).encode()).decode()


def connect_tunnel(host, port, config=None):
    config = config or SETTINGS
    if not re.fullmatch(r'[A-Za-z0-9.:-]+', host) or not 1 <= port <= 65535:
        raise ValueError('invalid_target')
    upstream = None
    for gateway in config['gateway_ips']:
        candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
            candidate.settimeout(12)
            candidate.connect((gateway, config['proxy_port']))
            upstream = candidate
            break
        except OSError:
            candidate.close()
    if upstream is None: raise RuntimeError('proxy_unreachable')
    try:
        authority = f'{host}:{port}'
        request = (f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n'
                   f'Proxy-Authorization: Basic {auth_header(config)}\r\n\r\n').encode()
        upstream.sendall(request)
        # Do not eat initial server bytes beyond the CONNECT response.
        response = bytearray()
        while not response.endswith(b'\r\n\r\n') and len(response) < 16384:
            chunk = upstream.recv(1)
            if not chunk: break
            response.extend(chunk)
        if not re.match(rb'^HTTP/1\.[01] 200(?: |\r)', response):
            raise RuntimeError('proxy_auth_or_connect_failed')
        upstream.settimeout(30)
        return upstream
    except Exception:
        upstream.close()
        raise


def tracked(sock):
    with LOCK: SOCKETS.add(sock)
    return sock


def close_socket(sock):
    with LOCK: SOCKETS.discard(sock)
    with contextlib.suppress(OSError): sock.shutdown(socket.SHUT_RDWR)
    sock.close()


def pipe(source, dest, counter):
    try:
        while not STOP.is_set():
            try: data = source.recv(65536)
            except socket.timeout: continue
            if not data: break
            view = memoryview(data)
            while view and not STOP.is_set():
                sent = dest.send(view)
                if sent <= 0: return
                add_bytes(counter, sent)
                view = view[sent:]
    except OSError: pass
    finally:
        with contextlib.suppress(OSError): dest.shutdown(socket.SHUT_WR)


def bridge(client, upstream):
    tracked(client); tracked(upstream)
    with LOCK: SESSION['active_connections'] = SESSION.get('active_connections', 0) + 1
    try:
        a = threading.Thread(target=pipe, args=(client, upstream, 'upload_bytes'), daemon=True)
        a.start()
        pipe(upstream, client, 'download_bytes')
        a.join(timeout=35)
    finally:
        close_socket(client); close_socket(upstream)
        with LOCK: SESSION['active_connections'] = max(0, SESSION['active_connections'] - 1)


def tls_request(host, method, path, body=b'', content_type=None):
    # A socketpair lets the same counted relay see TLS bytes, including DNS.
    upstream = connect_tunnel(host, 443)
    inner, outer = socket.socketpair()
    inner.settimeout(15); outer.settimeout(30)
    worker = threading.Thread(target=bridge, args=(outer, upstream), daemon=True)
    worker.start()
    try:
        with ssl.create_default_context().wrap_socket(inner, server_hostname=host) as secure:
            header = f'{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n'
            if content_type: header += f'Content-Type: {content_type}\r\nAccept: {content_type}\r\n'
            if body: header += f'Content-Length: {len(body)}\r\n'
            secure.sendall((header + '\r\n').encode() + body)
            response = http.client.HTTPResponse(secure)
            response.begin()
            if response.status != 200: raise RuntimeError('proxy_verification_failed')
            data = response.read(65537)
            if len(data) > 65536: raise RuntimeError('oversized_response')
            return data
    finally:
        inner.close()
        worker.join(timeout=2)


def dns_answer(query):
    if not 12 <= len(query) <= 65535: raise ValueError('bad_dns')
    # Proxy resolves dns.google itself. No guest DNS or UDP egress is needed.
    reply = tls_request('dns.google', 'POST', '/dns-query', query, 'application/dns-message')
    if len(reply) < 12 or reply[:2] != query[:2]: raise ValueError('bad_dns_response')
    return reply


def original_destination(client):
    raw = client.getsockopt(socket.SOL_IP, 80, 16)
    return socket.inet_ntoa(raw[4:8]), struct.unpack('!H', raw[2:4])[0]


class TCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        if not MAX_CONNECTIONS.acquire(blocking=False): return
        try:
            host, port = original_destination(self.request)
            bridge(self.request, connect_tunnel(host, port))
        except Exception:
            with LOCK: SESSION['error'] = 'A proxy connection failed; direct fallback is blocked.'
        finally: MAX_CONNECTIONS.release()


class DNSUDP(socketserver.BaseRequestHandler):
    def handle(self):
        if not MAX_CONNECTIONS.acquire(blocking=False): return
        try:
            query, sock = self.request
            sock.sendto(dns_answer(query), self.client_address)
        except Exception: pass
        finally: MAX_CONNECTIONS.release()


def recv_exact(sock, n):
    out = b''
    while len(out) < n:
        part = sock.recv(n - len(out))
        if not part: raise EOFError()
        out += part
    return out


class DNSTCP(socketserver.BaseRequestHandler):
    def handle(self):
        if not MAX_CONNECTIONS.acquire(blocking=False): return
        try:
            self.request.settimeout(15)
            size = struct.unpack('!H', recv_exact(self.request, 2))[0]
            reply = dns_answer(recv_exact(self.request, size))
            self.request.sendall(struct.pack('!H', len(reply)) + reply)
        except Exception: pass
        finally: MAX_CONNECTIONS.release()


def lease(command):
    value = command.get('lease_seconds', 180)
    if type(value) is not int or not 1 <= value <= LEASE_MAX: raise ValueError('invalid_lease')
    return value


def valid_session(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid_session')
    return value


class Control(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            command = json.loads(self.rfile.readline(8192))
            with LOCK:
                if command.get('session_id') not in (None, SESSION.get('session_id')):
                    raise ValueError('session_mismatch')
                if command['op'] == 'renew':
                    if SESSION.get('status') != 'enabled': raise ValueError('not_enabled')
                    SESSION['lease_expires_at'] = time.time() + lease(command)
                elif command['op'] in ('disable', 'stop'):
                    SESSION['status'] = 'disabled'
                    STOP.set()
                elif command['op'] != 'status': raise ValueError('invalid_operation')
                checkpoint()
                result = {'ok': True, **metadata(SESSION)}
            self.wfile.write((json.dumps(result) + '\n').encode())
        except Exception:
            self.wfile.write(b'{"ok":false,"error":"proxy_control_failed"}\n')


def rpc(command):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect(CONTROL)
        sock.sendall((json.dumps(command) + '\n').encode())
        with sock.makefile('rb') as f: return json.loads(f.readline(8192))


def daemon():
    global SESSION, SETTINGS
    SETTINGS = read_json(CONFIG)
    SESSION = read_json(STATE)
    # Automatic starts never restore an old proxy lease after VM reboot.
    if SESSION.get('boot_id') != boot_id() or time.time() >= SESSION.get('lease_expires_at', 0):
        remove_rules()
        SESSION.update(enabled=False, status='expired', active_connections=0)
        checkpoint()
        return
    if SESSION.get('status') == 'enabled': SESSION['metering_incomplete'] = True
    SESSION['active_connections'] = 0
    servers, running = [], []
    # A recovering daemon inherits its previous guard even if binding fails.
    guarded = execute(['nft', 'list', 'table', 'inet', TABLE], check=False).returncode == 0
    if guarded: SESSION['metering_incomplete'] = True
    try:
        # Bind all sockets before enabling the firewall. DNS NAT includes stub.
        servers.append(TCPServer(('127.0.0.1', RELAY_PORT), Relay))
        servers.append(TCPServer(('127.0.0.1', DNS_PORT), DNSTCP))
        udp = socketserver.ThreadingUDPServer(('127.0.0.1', DNS_PORT), DNSUDP)
        udp.daemon_threads = True
        servers.append(udp)
        with contextlib.suppress(FileNotFoundError): os.unlink(CONTROL)
        control = socketserver.ThreadingUnixStreamServer(CONTROL, Control)
        control.daemon_threads = True
        os.chmod(CONTROL, 0o600)
        servers.append(control)
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            running.append(server)
        install_rules(SETTINGS)
        guarded = True
        # Prove authenticated TCP+TLS before reporting enabled. This also meters
        # the verification bytes, since the provider bills them too.
        SESSION['exit_ip'] = str(ipaddress.ip_address(tls_request('ipv4.webshare.io', 'GET', '/').decode().strip()))
        SESSION.update(enabled=True, status='enabled', error=None)
        checkpoint()
        last = time.monotonic()
        while not STOP.wait(.25):
            if time.time() >= SESSION['lease_expires_at']:
                SESSION.update(status='expired')
                STOP.set()
                break
            if time.monotonic() - last >= 2:
                checkpoint(); last = time.monotonic()
    except Exception:
        # Leave the guard in place while the bounded lease remains, including
        # failed authentication. Disable is always available through Boat.
        SESSION.update(enabled=guarded, status='blocked' if guarded else 'failed',
                       error='Proxy could not connect. Internet is blocked until disabled or the lease expires.' if guarded else 'Proxy setup failed before routing could be enabled.')
        checkpoint()
        while guarded and not STOP.wait(.25):
            if time.time() >= SESSION.get('lease_expires_at', 0):
                SESSION['status'] = 'expired'; break
    finally:
        STOP.set()
        with LOCK:
            for sock in list(SOCKETS): close_socket(sock)
        # Deactivate guard only for explicit disable/expiry, never transport loss.
        remove_rules()
        for server in running: server.shutdown()
        for server in servers: server.server_close()
        deadline = time.monotonic() + 2
        while SESSION.get('active_connections', 0) and time.monotonic() < deadline:
            time.sleep(.01)
        if SESSION.get('active_connections', 0): SESSION['metering_incomplete'] = True
        if SESSION.get('status') in ('enabled', 'starting', 'blocked'):
            SESSION['status'] = 'disabled'
        SESSION.update(enabled=False, active_connections=0)
        checkpoint()
        with contextlib.suppress(FileNotFoundError): os.unlink(CONTROL)
        with contextlib.suppress(FileNotFoundError): CONFIG.unlink()


def status(command):
    try:
        result = rpc({'op': 'status', **command})
        if not result.get('ok'): raise ValueError('different_session')
        return result
    except (OSError, ValueError):
        state = read_json(STATE)
        if command.get('session_id') and command['session_id'] != state.get('session_id'):
            wanted = valid_session(command['session_id'])
            journal = ROOT / 'sessions' / (wanted + '.json')
            if not journal.exists():
                # The server may have lost its request before it reached us.
                # Explicit scoped absence lets it close that uncertain ledger.
                return {'ok': True, **metadata(dict(session_id=wanted,
                    status='absent', enabled=False, metering_incomplete=True))}
            state = read_json(journal)
        if (state.get('enabled') or state.get('status') == 'starting') and state.get('boot_id') != boot_id():
            # A provider resume restores the disk onto a new kernel. Transient
            # services and network rules are gone; never revive a saved lease.
            state.update(enabled=False, status='expired', active_connections=0,
                         metering_incomplete=True, checkpoint_at=time.time())
            if state.get('session_id'):
                write_json(ROOT / 'sessions' / (state['session_id'] + '.json'), state)
            if read_json(STATE).get('session_id') == state.get('session_id'):
                write_json(STATE, state)
        if state.get('enabled'):
            state.update(status='unreachable', metering_incomplete=True)
        return {'ok': True, **metadata(state)}


def disable(command):
    state = read_json(STATE)
    if command.get('session_id') and command['session_id'] != state.get('session_id'):
        return status(command)  # Never stop a later session from stale cleanup.
    with contextlib.suppress(OSError, ValueError): rpc({'op': 'disable', **command})
    for _ in range(80):
        state = read_json(STATE)
        if not state.get('enabled') and state.get('status') != 'starting': break
        time.sleep(.1)
    # On daemon death, remove only this feature's table and stop its cgroup.
    execute(['systemctl', 'stop', UNIT], check=False)
    remove_rules()
    state = read_json(STATE)
    state.update(enabled=False, status='disabled', active_connections=0, checkpoint_at=time.time())
    write_json(STATE, state)
    if state.get('session_id'): write_json(ROOT / 'sessions' / (state['session_id'] + '.json'), state)
    with contextlib.suppress(FileNotFoundError): CONFIG.unlink()
    return {'ok': True, **metadata(state)}


def enable(command):
    session = valid_session(command.get('session_id'))
    seconds = lease(command)
    state = read_json(STATE)
    if state.get('session_id') == session:
        # Same request replay cannot create a second billed session/reset totals.
        return status({'session_id': session})
    if state.get('enabled') or state.get('status') == 'starting': raise ValueError('another_session_active')
    host, port = command.get('proxy_host'), command.get('proxy_port')
    if not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host): raise ValueError('invalid_proxy')
    if type(port) is not int or not 1 <= port <= 65535: raise ValueError('invalid_proxy')
    for field in ('username', 'password'):
        value = command.get(field)
        if not isinstance(value, str) or not value or len(value) > 1024 or '\r' in value or '\n' in value:
            raise ValueError('invalid_credentials')
    gateways = sorted({x[4][0] for x in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)})
    if not gateways: raise ValueError('proxy_dns_failed')
    config = {k: command[k] for k in ('proxy_host', 'proxy_port', 'username', 'password')}
    config.update(gateway_ips=gateways, wireguard_endpoints=wg_endpoints())
    config.update(provider_storage())
    if command.get('control_host') is not None:
        control = control_endpoint(command['control_host'], command.get('control_port'))
        config.update(control_ips=control['ips'], control_port=control['port'])
    state = dict(session_id=session, enabled=False, status='starting', lease_expires_at=time.time()+seconds,
                 upload_bytes=0, download_bytes=0, active_connections=0, boot_id=boot_id(), metering_incomplete=False)
    write_json(CONFIG, config); write_json(STATE, state)
    execute(['systemctl', 'reset-failed', UNIT], check=False)
    execute(['systemd-run', '--unit='+UNIT, '--collect', '--property=Restart=on-failure',
             '--property=RestartSec=2', '--property=TimeoutStopSec=12',
             '--property=StandardOutput=null', '--property=StandardError=null',
             sys.executable, str(pathlib.Path(__file__).resolve()), '--daemon'])
    for _ in range(220):
        state = read_json(STATE)
        if state.get('status') != 'starting': return {'ok': True, **metadata(state)}
        time.sleep(.1)
    return {'ok': True, **metadata(state)}


def main():
    if os.geteuid() != 0: raise ValueError('root_required')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    if sys.argv[1:] == ['--daemon']:
        for signum in (signal.SIGTERM, signal.SIGINT): signal.signal(signum, lambda *_: STOP.set())
        daemon(); return
    command = json.loads(sys.stdin.readline(16384))
    if not isinstance(command, dict): raise ValueError('invalid_command')
    # Serialize mutation across independently invoked provider commands.
    with open(ROOT / 'command.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        op = command.get('op')
        if op == 'enable': result = enable(command)
        elif op in ('disable', 'stop'): result = disable(command)
        elif op == 'status': result = status(command)
        elif op == 'renew': result = rpc(command)
        else: raise ValueError('invalid_operation')
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"ok":false,"error":"proxy_operation_failed"}')
        sys.exit(1)
