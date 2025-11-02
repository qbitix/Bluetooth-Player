#!/usr/bin/env python3
import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

from dbus_next.aio import MessageBus
from dbus_next.constants import BusType

STATE_FILE = "/tmp/btplayer_state.json"
UPDATE_INTERVAL = 2 
WEB_HOST = "0.0.0.0"
WEB_PORT = 8080

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
        global latest_state
        latest_state = payload

    if not persist:
        return

    try:
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        logging.warning("Не удалось записать файл состояния %s: %s", STATE_FILE, exc)


async def find_player(bus: MessageBus) -> Optional[str]:
    """Ищет путь player0 на любом Bluetooth-адаптере."""
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

                if any("player0" in n.name for n in sub.nodes):
                    return f"{path}/player0"
    except Exception:
        pass
    return None


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
        if not player_path:
            player_path = await find_player(bus)
            if not player_path:
                async with state_lock:
                    current_snapshot = dict(latest_state)
                await update_state(
                    {
                        **current_snapshot,
                        "status": "idle",
                        "message": "Нет активного Bluetooth-плеера",
                        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    persist=False,
                )
                await asyncio.sleep(UPDATE_INTERVAL)
                continue
            logging.info("Обнаружен плеер: %s", player_path)

        data = await read_player_state(bus, player_path)

        if data.get("status") == "error":
            logging.warning("Ошибка чтения: %s", data.get("message"))
            await update_state(data, persist=False)
            player_path = None
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
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Length": str(len(body)),
        "Connection": "close",
    }
    if headers:
        base_headers.update(headers)

    header_lines = [f"HTTP/1.1 {status} {status_text}"]
    header_lines.extend(f"{key}: {value}" for key, value in base_headers.items())
    return ("\r\n".join(header_lines) + "\r\n\r\n").encode("utf-8") + body


async def http_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw_request = await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError:
        writer.close()
        await writer.wait_closed()
        return

    try:
        request_line = raw_request.decode("iso-8859-1").split("\r\n", 1)[0]
        method, path, _ = request_line.split(" ", 2)
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

    if method == "OPTIONS":
        response = build_http_response(b"", status=204)
    elif method != "GET":
        response = build_http_response(
            json.dumps({"error": "Method not allowed"}).encode("utf-8"),
            status=405,
        )
    else:
        route = path.split("?", 1)[0]
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
    server = await asyncio.start_server(http_handler, WEB_HOST, WEB_PORT)

    host, port = server.sockets[0].getsockname()[:2]
    logging.info("HTTP сервер запущен на http://%s:%s", host, port)
    logging.info("Интервал обновления D-Bus: %ss", UPDATE_INTERVAL)

    async with server:
        await asyncio.gather(
            monitor_loop(bus),
            server.serve_forever(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nОстановка мониторинга.")
