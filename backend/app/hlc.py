"""
backend/app/hlc.py
Hybrid Logical Clock — parse_hlc(), format_hlc(), compare(), now(), receive(),
and server-side clock-skew validation.
Mirrors frontend/js/hlc.js (see PROJECT_CONTEXT.md §3).

Format:
    <13-digit zero-padded wall-clock ms>-<4-digit zero-padded counter>-<deviceId>
"""

from dataclasses import dataclass
import time

MAX_COUNTER = 9999
MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000  # 24 hours in milliseconds


@dataclass(frozen=True)
class ParsedHLC:
    wall: int
    counter: int
    device_id: str


def format_hlc(wall_ms: int, counter: int, device_id: str) -> str:
    """Format wall ms, counter, and device_id into an HLC string."""
    wall_str = f"{max(0, int(wall_ms)):013d}"
    counter_str = f"{max(0, int(counter)):04d}"
    return f"{wall_str}-{counter_str}-{device_id}"


def parse_hlc(hlc_str: str) -> ParsedHLC:
    """
    Parse an HLC string into ParsedHLC(wall, counter, device_id).
    Raises ValueError if the string does not match the HLC format.
    """
    if not isinstance(hlc_str, str):
        raise ValueError(f"Invalid HLC string: {hlc_str!r}")

    first_dash = hlc_str.find("-")
    second_dash = hlc_str.find("-", first_dash + 1) if first_dash != -1 else -1
    if first_dash == -1 or second_dash == -1:
        raise ValueError(f"Invalid HLC string: {hlc_str!r}")

    wall_str = hlc_str[:first_dash]
    counter_str = hlc_str[first_dash + 1 : second_dash]
    device_id = hlc_str[second_dash + 1 :]

    if (
        len(wall_str) != 13
        or not wall_str.isdigit()
        or len(counter_str) != 4
        or not counter_str.isdigit()
        or not device_id
    ):
        raise ValueError(f"Invalid HLC string: {hlc_str!r}")

    return ParsedHLC(
        wall=int(wall_str),
        counter=int(counter_str),
        device_id=device_id,
    )


def compare(a: str, b: str) -> int:
    """
    Lexicographic comparison of two HLC strings.
    Returns -1 if a < b, 1 if a > b, 0 if a == b.
    """
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def is_clock_skewed(hlc_str: str, server_now_ms: int | None = None) -> bool:
    """
    Return True if the HLC's wall component is more than 24 hours ahead of
    server_now_ms. Past times are never considered skewed.
    Raises ValueError if hlc_str is malformed.
    """
    parsed = parse_hlc(hlc_str)
    now_ms = int(time.time() * 1000) if server_now_ms is None else int(server_now_ms)
    return parsed.wall > now_ms + MAX_CLOCK_SKEW_MS


def now(
    last_hlc: str | None,
    device_id: str,
    wall_ms: int | None = None,
) -> str:
    """Advance the HLC for a local event."""
    now_wall = max(0, int(time.time() * 1000) if wall_ms is None else int(wall_ms))
    next_wall = now_wall
    next_counter = 0

    if last_hlc:
        parsed = parse_hlc(last_hlc)
        if now_wall > parsed.wall:
            next_wall = now_wall
            next_counter = 0
        else:
            next_wall = parsed.wall
            next_counter = parsed.counter + 1
            if next_counter > MAX_COUNTER:
                next_wall += 1
                next_counter = 0

    return format_hlc(next_wall, next_counter, device_id)


def receive(
    remote_hlc: str,
    local_hlc: str | None,
    device_id: str,
    wall_ms: int | None = None,
) -> str:
    """Advance the local HLC upon receiving a remote HLC."""
    now_wall = max(0, int(time.time() * 1000) if wall_ms is None else int(wall_ms))
    remote = parse_hlc(remote_hlc)
    local = parse_hlc(local_hlc) if local_hlc else ParsedHLC(wall=-1, counter=0, device_id=device_id)

    max_wall = max(now_wall, local.wall, remote.wall)

    next_counter = 0
    if max_wall == local.wall and max_wall == remote.wall:
        next_counter = max(local.counter, remote.counter) + 1
    elif max_wall == local.wall:
        next_counter = local.counter + 1
    elif max_wall == remote.wall:
        next_counter = remote.counter + 1

    final_wall = max_wall
    if next_counter > MAX_COUNTER:
        final_wall += 1
        next_counter = 0

    return format_hlc(final_wall, next_counter, device_id)
