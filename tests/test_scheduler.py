from datetime import datetime, timedelta
import pytest

from diaguru.scheduler import Scheduler


def test_add_and_list_tasks():
    sched = Scheduler()
    start = datetime.now()
    end = start + timedelta(hours=1)
    sched.add_task("Task1", start, end)

    tasks = sched.list_tasks()
    assert len(tasks) == 1
    assert tasks[0].name == "Task1"
    assert tasks[0].start == start
    assert tasks[0].end == end


def test_conflict_detection():
    sched = Scheduler()
    start = datetime.now()
    end = start + timedelta(hours=2)
    sched.add_task("Task1", start, end)

    with pytest.raises(ValueError):
        sched.add_task("Task2", start + timedelta(minutes=30), end + timedelta(minutes=30))

