"""One server's queue: what's playing, what's next, and the loop and shuffle rules. No Discord in here, so it can be tested alone."""
import random
from collections import deque

LOOP_MODES = ("off", "track", "queue")


class PlayQueue:
    def __init__(self, limit: int = 200):
        self.limit = limit
        self.upcoming: deque = deque()
        self.history: list = []
        self.current = None
        self.loop = "off"

    def __len__(self):
        return len(self.upcoming)

    def add(self, items: list) -> int:
        room = max(0, self.limit - len(self.upcoming))
        items = list(items)[:room]
        self.upcoming.extend(items)
        return len(items)

    def advance(self, skip: bool = False):
        """The song that should play next (None when the queue is done), moving on from the current one.
        Looping a single song repeats it when it ends by itself, but a skip always moves on."""
        if self.current is not None:
            if self.loop == "track" and not skip:
                return self.current
            self.history.append(self.current)
            self.history = self.history[-50:]
            if self.loop == "queue":
                self.upcoming.append(self.current)
        self.current = self.upcoming.popleft() if self.upcoming else None
        return self.current

    def back(self) -> bool:
        """Lines up the song before the current one to play next (the current one follows it). False when there's nothing before it."""
        if not self.history:
            return False
        prev = self.history.pop()
        if self.current is not None:
            self.upcoming.appendleft(self.current)
        self.upcoming.appendleft(prev)
        self.current = None
        return True

    def restart(self) -> bool:
        """Lines up the current song to play again from the start."""
        if self.current is None:
            return False
        self.upcoming.appendleft(self.current)
        self.current = None
        return True

    def shuffle(self):
        items = list(self.upcoming)
        random.shuffle(items)
        self.upcoming = deque(items)

    def remove(self, position: int):
        """Take out the song at a 1-based position in the upcoming list."""
        if not 1 <= position <= len(self.upcoming):
            raise IndexError("No song at that position")
        items = list(self.upcoming)
        gone = items.pop(position - 1)
        self.upcoming = deque(items)
        return gone

    def clear(self):
        self.upcoming.clear()

    def cycle_loop(self, mode: str | None = None) -> str:
        self.loop = mode if mode in LOOP_MODES else LOOP_MODES[(LOOP_MODES.index(self.loop) + 1) % len(LOOP_MODES)]
        return self.loop
