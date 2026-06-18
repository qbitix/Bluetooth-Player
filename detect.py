#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import json
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

from dbus_next.aio import MessageBus
from dbus_next.constants import BusType

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_env_file(path: str = os.path.join(SCRIPT_DIR, ".env")) -> None:
    if not os.path.isfile(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            name, value = line.split("=", 1)
            name = name.strip()
            value = value.strip().strip("\"'")

            if name and name not in os.environ:
                os.environ[name] = value


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


load_env_file()

STATE_FILE = os.environ.get("PLAYER_STATE_FILE", "runtime/btplayer_state.json")
if not os.path.isabs(STATE_FILE):
    STATE_FILE = os.path.join(SCRIPT_DIR, STATE_FILE)
UPDATE_INTERVAL = env_float("PLAYER_DBUS_INTERVAL", 2)
TIMELINE_INTERVAL = env_float("PLAYER_TIMELINE_INTERVAL", 0.25)
WEB_HOST = os.environ.get("PLAYER_WS_HOST", "0.0.0.0")
WEB_PORT = env_int("PLAYER_WS_PORT", 8080)
WS_PATH = "/ws"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

HTTP_STATUS_TEXT = {
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    500: "Internal Server Error",
}

latest_state: Dict[str, Any] = {
    "status": "init",
    "message": "Ожидание первого обновления",
    "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
}
state_lock = asyncio.Lock()
latest_state_monotonic = time.monotonic()
ws_clients: set[asyncio.StreamWriter] = set()
ws_clients_lock = asyncio.Lock()
active_player_path: Optional[str] = None
active_player_lock = asyncio.Lock()


def track_key(state: Dict[str, Any]) -> Optional[str]:
    artist = (state.get("artist") or "").strip().lower()
    title = (state.get("title") or "").strip().lower()
    if not artist and not title:
        return None
    return f"{artist}::{title}"


async def update_state(payload: Dict[str, Any], persist: bool = True) -> None:
    """Сохраняет новое состояние и опционально пишет его в файл для PHP."""
    payload = dict(payload)
    payload.setdefault("updated", time.strftime("%Y-%m-%d %H:%M:%S"))

    async with state_lock:
        global latest_state, latest_state_monotonic
        latest_state = payload
        latest_state_monotonic = time.monotonic()

    if not persist:
        await broadcast_state(payload)
        return

    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        logging.warning("Could not write state file %s: %s", STATE_FILE, exc)

    await broadcast_state(payload)


async def set_active_player_path(player_path: Optional[str]) -> None:
    async with active_player_lock:
        global active_player_path
        active_player_path = player_path


async def get_active_player_path() -> Optional[str]:
    async with active_player_lock:
        return active_player_path


async def list_player_paths(bus: MessageBus) -> list[str]:
    """Ищет все Bluetooth MediaPlayer на всех адаптерах."""
    players: list[str] = []

    try:
        root = await bus.introspect("org.bluez", "/org/bluez")
        for hci in root.nodes:
            if not hci.name.startswith("hci"):
                continue
            base = f"/org/bluez/{hci.name}"
            try:
                intros = await bus.introspect("org.bluez", base)
            except Exception:
                continue

            for node in intros.nodes:
                if not node.name.startswith("dev_"):
                    continue
                path = f"{base}/{node.name}"
                try:
                    sub = await bus.introspect("org.bluez", path)
                except Exception:
                    continue

                for player_node in sub.nodes:
                    if player_node.name.startswith("player"):
                        players.append(f"{path}/{player_node.name}")
    except Exception:
        pass

    return players


def player_score(state: Dict[str, Any], player_path: str, current_path: Optional[str]) -> Tuple[int, int, int]:
    status = str(state.get("status") or "").lower()
    has_track = track_key(state) is not None
    has_position = isinstance(state.get("position_ms"), (int, float))

    status_score = {
        "playing": 4,
        "paused": 3,
        "stopped": 2,
    }.get(status, 1)

    return (
        status_score,
        1 if has_track and has_position else 0,
        1 if player_path == current_path else 0,
    )


async def find_player(bus: MessageBus, current_path: Optional[str] = None) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Выбирает лучший активный Bluetooth-плеер среди всех доступных."""
    best_path: Optional[str] = None
    best_state: Optional[Dict[str, Any]] = None
    best_score: Tuple[int, int, int] = (-1, -1, -1)

    for player_path in await list_player_paths(bus):
        state = await read_player_state(bus, player_path)
        if state.get("status") == "error":
            continue

        score = player_score(state, player_path, current_path)
        if score > best_score:
            best_score = score
            best_path = player_path
            best_state = state

    if best_path:
        return best_path, best_state

    return None, None


async def read_player_state(bus: MessageBus, player_path: str) -> Dict[str, Any]:
    """Читает свойства плеера, если он активен."""
    try:
        intros = await bus.introspect("org.bluez", player_path)
        obj = bus.get_proxy_object("org.bluez", player_path, intros)
        props = obj.get_interface("org.freedesktop.DBus.Properties")

        status = (await props.call_get("org.bluez.MediaPlayer1", "Status")).value
        position = (await props.call_get("org.bluez.MediaPlayer1", "Position")).value
        track_dict = (await props.call_get("org.bluez.MediaPlayer1", "Track")).value

        def extract(field: str, default: Any = None) -> Any:
            if field not in track_dict:
                return default
            value = track_dict[field].value
            return value if value not in (None, "") else default

        duration_ms = extract("Duration", 0) or 0
        if isinstance(duration_ms, float):
            duration_ms = int(duration_ms)

        data = {
            "title": extract("Title", "Unknown"),
            "artist": extract("Artist", "Unknown"),
            "album": extract("Album", "Unknown"),
            "duration_ms": duration_ms,
            "position_ms": position,
            "status": status,
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        return data
    except Exception as exc:
        return {
            "status": "error",
            "message": str(exc),
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        }


async def monitor_loop(bus: MessageBus) -> None:
    """Основной цикл мониторинга D-Bus плеера."""
    player_path: Optional[str] = None
    previous_track: Optional[str] = None

    while True:
        detected_player_path, data = await find_player(bus, player_path)
        if not detected_player_path:
            async with state_lock:
                current_snapshot = dict(latest_state)
            await update_state(
                {
                    **current_snapshot,
                    "status": "idle",
                    "message": "No active Bluetooth player",
                    "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
                },
                persist=False,
            )
            player_path = None
            await set_active_player_path(None)
            await asyncio.sleep(UPDATE_INTERVAL)
            continue

        if detected_player_path != player_path:
            player_path = detected_player_path
            await set_active_player_path(player_path)
            previous_track = None
            logging.info("Active player: %s", player_path)

        if data is None:
            data = await read_player_state(bus, player_path)

        if data.get("status") == "error":
            logging.warning("Read error: %s", data.get("message"))
            await update_state(data, persist=False)
            player_path = None
            await set_active_player_path(None)
            await asyncio.sleep(UPDATE_INTERVAL)
            continue

        current_track = track_key(data)
        if previous_track != current_track:
            logging.info(
                "[%s] %s — %s (%s)",
                data["updated"],
                data.get("artist"),
                data.get("title"),
                data.get("status"),
            )
            previous_track = current_track
        else:
            logging.debug(
                "[%s] %s — %s (%s %.2fs)",
                data["updated"],
                data.get("artist"),
                data.get("title"),
                data.get("status"),
                data.get("position_ms", 0) / 1000.0,
            )

        await update_state(data, persist=True)
        await asyncio.sleep(UPDATE_INTERVAL)


def build_http_response(
    body: bytes,
    status: int = 200,
    headers: Optional[Dict[str, str]] = None,
) -> bytes:
    status_text = HTTP_STATUS_TEXT.get(status, "OK")
    base_headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Length": str(len(body)),
        "Connection": "close",
    }
    if headers:
        base_headers.update(headers)

    header_lines = [f"HTTP/1.1 {status} {status_text}"]
    header_lines.extend(f"{key}: {value}" for key, value in base_headers.items())
    return ("\r\n".join(header_lines) + "\r\n\r\n").encode("utf-8") + body


def parse_headers(raw_request: bytes) -> tuple[str, str, Dict[str, str]]:
    lines = raw_request.decode("iso-8859-1").split("\r\n")
    method, path, _ = lines[0].split(" ", 2)
    headers: Dict[str, str] = {}

    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()

    return method, path, headers


async def read_http_body(reader: asyncio.StreamReader, headers: Dict[str, str]) -> bytes:
    content_length = int(headers.get("content-length", "0") or 0)
    if content_length <= 0:
        return b""

    return await reader.readexactly(content_length)


async def run_player_command(bus: MessageBus, player_path: str, command: str) -> Dict[str, Any]:
    try:
        intros = await bus.introspect("org.bluez", player_path)
        obj = bus.get_proxy_object("org.bluez", player_path, intros)
        player = obj.get_interface("org.bluez.MediaPlayer1")
        next_status: Optional[str] = None

        if command == "previous":
            await player.call_previous()
        elif command == "next":
            await player.call_next()
        elif command == "play":
            await player.call_play()
            next_status = "playing"
        elif command == "pause":
            await player.call_pause()
            next_status = "paused"
        elif command == "playPause":
            async with state_lock:
                state = dict(latest_state)

            if str(state.get("status") or "").lower() == "playing":
                await player.call_pause()
                next_status = "paused"
            else:
                await player.call_play()
                next_status = "playing"

        if next_status:
            async with state_lock:
                snapshot = dict(latest_state)
            await update_state({**snapshot, "status": next_status}, persist=True)

        return {"status": "ok", "command": command, "player": player_path}
    except Exception as exc:
        logging.warning("Could not run command %s for %s: %s", command, player_path, exc)
        return {"status": "error", "error": str(exc), "command": command, "player": player_path}


async def control_player(bus: MessageBus, command: str) -> Dict[str, Any]:
    commands = {"previous", "play", "pause", "playPause", "next"}
    if command not in commands:
        return {"status": "error", "error": "Unknown command"}

    current_path = await get_active_player_path()
    if current_path:
        result = await run_player_command(bus, current_path, command)
        if result.get("status") == "ok":
            return result

    player_path, _ = await find_player(bus, current_path)
    if not player_path:
        return {"status": "error", "error": "No active Bluetooth player"}

    if player_path != current_path:
        await set_active_player_path(player_path)

    return await run_player_command(bus, player_path, command)


def is_websocket_request(method: str, route: str, headers: Dict[str, str]) -> bool:
    upgrade = headers.get("upgrade", "").lower()
    connection = headers.get("connection", "").lower()
    return (
        method == "GET"
        and route == WS_PATH
        and upgrade == "websocket"
        and "upgrade" in connection
        and headers.get("sec-websocket-key", "") != ""
    )


def encode_ws_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    length = len(payload)
    first_byte = 0x80 | opcode

    if length < 126:
        return bytes([first_byte, length]) + payload
    if length <= 0xFFFF:
        return bytes([first_byte, 126]) + length.to_bytes(2, "big") + payload
    return bytes([first_byte, 127]) + length.to_bytes(8, "big") + payload


def ws_json_payload(message_type: str, data: Dict[str, Any]) -> bytes:
    return json.dumps(
        {
            "type": message_type,
            "data": data,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


async def send_ws_frame(writer: asyncio.StreamWriter, payload: bytes, opcode: int = 0x1) -> None:
    writer.write(encode_ws_frame(payload, opcode))
    await writer.drain()


async def has_ws_clients() -> bool:
    async with ws_clients_lock:
        return bool(ws_clients)


async def broadcast_ws_payload(payload: bytes) -> None:
    async with ws_clients_lock:
        clients = list(ws_clients)

    if not clients:
        return

    stale_clients: list[asyncio.StreamWriter] = []
    for writer in clients:
        try:
            await asyncio.wait_for(send_ws_frame(writer, payload), timeout=2)
        except Exception:
            stale_clients.append(writer)

    if stale_clients:
        async with ws_clients_lock:
            for writer in stale_clients:
                ws_clients.discard(writer)
                writer.close()


async def broadcast_state(state: Dict[str, Any]) -> None:
    await broadcast_ws_payload(ws_json_payload("playerState", state))


def make_timeline_payload(state: Dict[str, Any], anchor_time: float) -> Dict[str, Any]:
    position = state.get("position_ms", 0) or 0
    duration = state.get("duration_ms", 0) or 0
    status = state.get("status", "stopped")

    if status == "playing":
        position += int((time.monotonic() - anchor_time) * 1000)

    if duration:
        position = min(position, duration)
    position = max(position, 0)

    return {
        "position_ms": position,
        "duration_ms": duration,
        "status": status,
        "track_key": track_key(state),
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


async def timeline_loop() -> None:
    while True:
        if await has_ws_clients():
            async with state_lock:
                snapshot = dict(latest_state)
                anchor_time = latest_state_monotonic

            await broadcast_ws_payload(
                ws_json_payload("timeline", make_timeline_payload(snapshot, anchor_time))
            )

        await asyncio.sleep(TIMELINE_INTERVAL)


async def read_ws_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    header = await reader.readexactly(2)
    opcode = header[0] & 0x0F
    masked = bool(header[1] & 0x80)
    length = header[1] & 0x7F

    if length == 126:
        length = int.from_bytes(await reader.readexactly(2), "big")
    elif length == 127:
        length = int.from_bytes(await reader.readexactly(8), "big")

    mask = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length) if length else b""

    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

    return opcode, payload


async def websocket_handler(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    headers: Dict[str, str],
    bus: MessageBus,
) -> None:
    key = headers["sec-websocket-key"]
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    ).encode("ascii")

    writer.write(response)
    await writer.drain()

    async with ws_clients_lock:
        ws_clients.add(writer)

    async with state_lock:
        snapshot = dict(latest_state)
        anchor_time = latest_state_monotonic
    await send_ws_frame(writer, ws_json_payload("playerState", snapshot))
    await send_ws_frame(writer, ws_json_payload("timeline", make_timeline_payload(snapshot, anchor_time)))

    try:
        while True:
            opcode, payload = await read_ws_frame(reader)

            if opcode == 0x8:
                await send_ws_frame(writer, payload, opcode=0x8)
                break
            if opcode == 0x9:
                await send_ws_frame(writer, payload, opcode=0xA)
            if opcode == 0x1:
                try:
                    message = json.loads(payload.decode("utf-8") or "{}")
                except json.JSONDecodeError:
                    continue

                if message.get("type") == "control":
                    command = str(message.get("command") or "")
                    result = await control_player(bus, command)
                    await send_ws_frame(writer, ws_json_payload("controlResult", result))
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        async with ws_clients_lock:
            ws_clients.discard(writer)
        writer.close()
        await writer.wait_closed()


async def http_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, bus: MessageBus) -> None:
    try:
        raw_request = await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError:
        writer.close()
        await writer.wait_closed()
        return

    try:
        method, path, headers = parse_headers(raw_request)
    except ValueError:
        response = build_http_response(
            json.dumps({"error": "Bad request"}).encode("utf-8"),
            status=400,
        )
        writer.write(response)
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    route = path.split("?", 1)[0]
    if is_websocket_request(method, route, headers):
        await websocket_handler(reader, writer, headers, bus)
        return

    if method == "OPTIONS":
        response = build_http_response(b"", status=204)
    elif route == "/control" and method == "POST":
        try:
            request_body = await read_http_body(reader, headers)
            payload = json.loads(request_body.decode("utf-8") or "{}")
            command = str(payload.get("command") or "")
            result = await control_player(bus, command)
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            response = build_http_response(body, status=200 if result.get("status") == "ok" else 400)
        except (asyncio.IncompleteReadError, json.JSONDecodeError, ValueError):
            body = json.dumps({"status": "error", "error": "Bad request"}).encode("utf-8")
            response = build_http_response(body, status=400)
    elif method != "GET":
        response = build_http_response(
            json.dumps({"error": "Method not allowed"}).encode("utf-8"),
            status=405,
        )
    else:
        if route in ("/", "/state"):
            async with state_lock:
                payload = dict(latest_state)
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            response = build_http_response(body, status=200)
        elif route == "/health":
            body = json.dumps({"status": "ok"}).encode("utf-8")
            response = build_http_response(body, status=200)
        else:
            body = json.dumps({"error": "Not found"}).encode("utf-8")
            response = build_http_response(body, status=404)

    writer.write(response)
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    await update_state(latest_state, persist=True)

    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()

    async def server_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await http_handler(reader, writer, bus)

    server = await asyncio.start_server(server_handler, WEB_HOST, WEB_PORT)

    host, port = server.sockets[0].getsockname()[:2]
    logging.info("HTTP/WebSocket сервер запущен на http://%s:%s", host, port)
    logging.info("WebSocket endpoint: ws://%s:%s%s", host, port, WS_PATH)
    logging.info("Интервал обновления D-Bus: %ss", UPDATE_INTERVAL)
    logging.info("Интервал обновления timeline: %.2fs", TIMELINE_INTERVAL)

    async with server:
        await asyncio.gather(
            monitor_loop(bus),
            timeline_loop(),
            server.serve_forever(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nОстановка мониторинга.")
