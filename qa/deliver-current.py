"""Deliver the audited release separately; preserve every previous release."""
from pathlib import Path
from runpy import run_path

run_path(str(Path(__file__).with_name('deliver-five-round.py')), run_name='__main__')
