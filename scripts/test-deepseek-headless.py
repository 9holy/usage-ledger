#!/usr/bin/env python3
"""Compatibility entry point for the DeepSeek tests in the full native harness.

Usage: python scripts/test-deepseek-headless.py [--output /tmp/dsh-check]
See test-native-headless.py for requirements, dependency locking, and exclusions.
"""

from pathlib import Path
import subprocess
import sys


result = subprocess.run([
    sys.executable, str(Path(__file__).with_name("test-native-headless.py")),
    "--test-filter", "deepseek", *sys.argv[1:],
])
raise SystemExit(result.returncode)
