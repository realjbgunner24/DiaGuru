# DiaGuru

This repository contains a simple schedule planning library written in Python. It provides
a `Scheduler` class for managing tasks and a small command line interface.

## Installing dependencies

Install `pytest` for running the tests:

```bash
pip install pytest
```

## Running tests

```bash
python -m pytest -q
```

## Command line usage

```
python -m diaguru.scheduler add "Task name" 2024-01-01T10:00 2024-01-01T11:00
python -m diaguru.scheduler list
python -m diaguru.scheduler remove "Task name"
```

