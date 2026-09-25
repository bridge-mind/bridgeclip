import asyncio
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from network_guard import _guard_async_connect, _public_address


class NetworkGuardTests(unittest.TestCase):
    def test_rejects_private_addresses_at_connect(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            for host in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2"):
                with self.subTest(host=host), self.assertRaises(OSError):
                    _public_address(sock, (host, 443))
            self.assertEqual(_public_address(sock, ("8.8.8.8", 443)), ("8.8.8.8", 443))
        finally:
            sock.close()

    def test_rejects_private_dns_result_even_after_initial_url_validation(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443))]
            with patch.object(socket, "getaddrinfo", return_value=private), self.assertRaises(OSError):
                _public_address(sock, ("public.example", 443))
            public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
            with patch.object(socket, "getaddrinfo", return_value=public):
                self.assertEqual(_public_address(sock, ("public.example", 443)), ("8.8.8.8", 443))
        finally:
            sock.close()

    def test_async_connect_checks_and_pins_destination(self):
        addresses = []

        async def original(_loop, _sock, address):
            addresses.append(address)
            return address

        guarded = _guard_async_connect(original)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with self.assertRaisesRegex(OSError, "Local network destinations"):
                asyncio.run(guarded(None, sock, ("127.0.0.1", 443)))
            self.assertEqual(addresses, [])

            public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
            with patch.object(socket, "getaddrinfo", return_value=public):
                result = asyncio.run(guarded(None, sock, ("public.example", 443)))
            self.assertEqual(result, ("8.8.8.8", 443))
            self.assertEqual(addresses, [("8.8.8.8", 443)])
        finally:
            sock.close()

    @unittest.skipUnless(sys.platform == "win32", "Windows Proactor test")
    def test_windows_proactor_rejects_loopback_sock_connect(self):
        # Install in a child process because the guard patches sockets and the
        # event loop for its lifetime.
        script = """
import asyncio
import socket
import network_guard

network_guard.install()
async def check():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
            client.setblocking(False)
            try:
                await asyncio.get_running_loop().sock_connect(client, listener.getsockname())
            except OSError as error:
                assert 'Local network destinations are not allowed' in str(error), error
            else:
                raise AssertionError('Proactor connected to a local TCP destination')

asyncio.run(check())
"""
        done = subprocess.run(
            [sys.executable, "-c", script], cwd=Path(__file__).parent,
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_asyncio_socketpair_works_without_allowing_local_destinations(self):
        # Force the Windows TCP fallback on every platform. A subprocess keeps
        # the process-wide socket guard out of other tests.
        if not hasattr(socket, "_fallback_socketpair"):
            self.skipTest("Python does not expose its TCP socketpair fallback")
        script = """
import asyncio
import socket
import threading
import network_guard as guard

socket.socketpair = socket._fallback_socketpair
guard.install()
assert asyncio.run(asyncio.sleep(0, result=1)) == 1
assert asyncio.run(asyncio.sleep(0, result=2)) == 2

# Hold the private pair at its own connect and prove that an ordinary socket
# cannot reach even that temporary listener while construction is in progress.
original_connect = guard._original_connect
ready = threading.Event()
proceed = threading.Event()
state = {}
def delayed_connect(sock, address):
    state['address'] = address
    ready.set()
    assert proceed.wait(5)
    return original_connect(sock, address)
guard._original_connect = delayed_connect
def make_pair():
    try:
        state['pair'] = socket.socketpair()
    except BaseException as error:
        state['error'] = error
worker = threading.Thread(target=make_pair)
worker.start()
try:
    assert ready.wait(5)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.connect(state['address'])
        except OSError as error:
            assert 'Local network destinations are not allowed' in str(error)
        else:
            raise AssertionError('The guard allowed an arbitrary loopback connection')
finally:
    proceed.set()
    worker.join(5)
assert not worker.is_alive()
assert 'error' not in state, state.get('error')
for sock in state['pair']:
    sock.close()

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    try:
        sock.connect(('127.0.0.1', 443))
    except OSError as error:
        assert 'Local network destinations are not allowed' in str(error)
    else:
        raise AssertionError('The guard allowed an arbitrary loopback connection')
"""
        done = subprocess.run(
            [sys.executable, "-c", script], cwd=Path(__file__).parent,
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == "__main__":
    unittest.main()
