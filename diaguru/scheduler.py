from dataclasses import dataclass
from datetime import datetime
from typing import List

@dataclass
class Task:
    name: str
    start: datetime
    end: datetime

class Scheduler:
    def __init__(self) -> None:
        self._tasks: List[Task] = []

    def add_task(self, name: str, start: datetime, end: datetime) -> None:
        if end <= start:
            raise ValueError("End time must be after start time")
        if self.has_conflict(start, end):
            raise ValueError("Task conflicts with existing schedule")
        self._tasks.append(Task(name=name, start=start, end=end))

    def list_tasks(self) -> List[Task]:
        return list(self._tasks)

    def remove_task(self, name: str) -> None:
        self._tasks = [t for t in self._tasks if t.name != name]

    def has_conflict(self, start: datetime, end: datetime) -> bool:
        for task in self._tasks:
            if start < task.end and end > task.start:
                return True
        return False

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Simple schedule planner")
    parser.add_argument("command", choices=["add", "list", "remove"], help="Action to perform")
    parser.add_argument("name", nargs="?", help="Task name")
    parser.add_argument("start", nargs="?", help="Start time in YYYY-mm-ddTHH:MM format")
    parser.add_argument("end", nargs="?", help="End time in YYYY-mm-ddTHH:MM format")

    args = parser.parse_args()

    sched = Scheduler()
    if args.command == "add":
        if not (args.name and args.start and args.end):
            parser.error("add requires name, start and end")
        start_dt = datetime.fromisoformat(args.start)
        end_dt = datetime.fromisoformat(args.end)
        sched.add_task(args.name, start_dt, end_dt)
        print("Task added")
    elif args.command == "list":
        for task in sched.list_tasks():
            print(f"{task.name}: {task.start} -> {task.end}")
    elif args.command == "remove":
        if not args.name:
            parser.error("remove requires task name")
        sched.remove_task(args.name)
        print("Task removed")
