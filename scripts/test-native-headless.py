#!/usr/bin/env python3
"""Run the native business tests without installing the Tauri desktop SDKs.

Requires Python 3.11+, Cargo, and a C compiler (for bundled SQLite/Zstandard).
Usage: python scripts/test-native-headless.py [--output /tmp/native-check]
       python scripts/test-native-headless.py --test-filter usage_monitor::

The generated library retains every production business module, its tests, and
the non-UI helpers/tests from main.rs, including the shared ENV_LOCK. It removes
only the Tauri command attributes, desktop_shell.rs, and main's desktop startup
function. The State wrapper and spawn_blocking adapter replace Tauri plumbing;
database, collector, parser, pricing, quota, network proxy, and finance logic are
the actual production sources. No business implementation or test is stubbed.

This does not validate desktop_shell tests, Tauri command registration/macros,
window/tray/updater lifecycle, or behavior on a different operating system. Use
the full native CI matrix for those checks. Existing ignored tests stay ignored:
they require explicit real-data copies, authenticated clients, or benchmarks.

All dependencies must match src-tauri/Cargo.lock, including transitive versions.
Test HOME/client/data paths point to a disposable fixture directory. The harness
and build cache remain at the printed output path for inspection and reuse.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib


MARKER = ".usage-ledger-native-headless"
SHIM = """#![allow(dead_code, unused_imports)]
extern crate self as tauri;
pub struct State<'a, T>(&'a T);
impl<'a, T> State<'a, T> {
    pub fn inner(&self) -> &'a T { self.0 }
}
pub mod async_runtime { pub use tokio::task::spawn_blocking; }
"""


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{json.dumps(key)} = {toml_value(item)}" for key, item in value.items()
        ) + " }"
    raise ValueError(f"Unsupported dependency value: {value!r}")


def dependency_spec(name, spec, locked_root, packages):
    spec = {"version": spec} if isinstance(spec, str) else dict(spec)
    if any(key in spec for key in ("path", "git", "workspace", "registry")):
        raise ValueError(f"Review headless handling of non-default dependency {name}")
    package_name = spec.get("package", name)
    refs = [entry.split() for entry in locked_root["dependencies"]]
    refs = [entry for entry in refs if entry[0] == package_name]
    if len(refs) != 1:
        raise ValueError(f"Cannot identify locked direct dependency {name}")
    candidates = [package for package in packages if package["name"] == package_name]
    if len(refs[0]) > 1:
        candidates = [package for package in candidates if package["version"] == refs[0][1]]
    if len(candidates) != 1:
        raise ValueError(f"Cannot identify the exact locked version for {name}")
    spec["version"] = "=" + candidates[0]["version"]
    return spec


def make_manifest(original, lock):
    package = original["package"]
    locked_root = next(
        entry for entry in lock["package"]
        if entry["name"] == package["name"] and entry["version"] == package["version"]
        and "source" not in entry
    )
    lines = [
        "[package]", 'name = "usage-ledger-native-headless"',
        f'version = {toml_value(package["version"])}',
        f'edition = {toml_value(package["edition"])}',
        "[profile.dev]", "debug = 0", "incremental = false",
        "[profile.test]", "debug = 0", "incremental = false",
    ]

    def add_dependencies(header, dependencies):
        kept = {key: value for key, value in dependencies.items()
                if key != "tauri" and not key.startswith("tauri-")}
        if kept:
            lines.append(header)
            for name, spec in kept.items():
                pinned = dependency_spec(name, spec, locked_root, lock["package"])
                lines.append(f"{json.dumps(name)} = {toml_value(pinned)}")

    add_dependencies("[dependencies]", original.get("dependencies", {}))
    add_dependencies("[dev-dependencies]", original.get("dev-dependencies", {}))
    for target, config in original.get("target", {}).items():
        add_dependencies(f"[target.{toml_value(target)}.dependencies]", config.get("dependencies", {}))
        add_dependencies(f"[target.{toml_value(target)}.dev-dependencies]", config.get("dev-dependencies", {}))
    return "\n".join(lines) + "\n"


def generate(repo, output):
    native = repo / "src-tauri"
    source = native / "src"
    if output.exists() and any(output.iterdir()) and not (output / MARKER).is_file():
        raise ValueError(f"Refusing to overwrite an unrelated nonempty directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    (output / MARKER).write_text("Generated by scripts/test-native-headless.py\n", encoding="utf-8")
    destination = output / "src"
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    for original in source.rglob("*"):
        relative = original.relative_to(source)
        if not original.is_file() or relative.as_posix() in ("main.rs", "desktop_shell.rs"):
            continue
        copied = destination / relative
        copied.parent.mkdir(parents=True, exist_ok=True)
        if original.suffix == ".rs":
            copied.write_text(original.read_text(encoding="utf-8").replace("#[tauri::command]", ""), encoding="utf-8")
        else:
            shutil.copyfile(original, copied)

    main = (source / "main.rs").read_text(encoding="utf-8")
    # Fail if the known entry-point boundaries change; never silently drop tests.
    start = "\nfn main() {"
    end = "\n/// 进程级环境变量互斥锁"
    if main.count(start) != 1 or main.count(end) != 1:
        raise ValueError("main.rs layout changed; review the desktop entry-point extraction")
    before, desktop = main.split(start, 1)
    _, after = desktop.split(end, 1)
    main = before + end + after
    main = main.replace('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]', "")
    main = main.replace("mod desktop_shell;", "").replace("#[tauri::command]", "")
    main, removed = re.subn(r"use desktop_shell::\{[^}]+\};", "", main)
    if removed != 1 or "pub(crate) static ENV_LOCK" not in main:
        raise ValueError("Review desktop imports/shared test environment lock extraction")
    (destination / "lib.rs").write_text(SHIM + main, encoding="utf-8")
    shutil.copytree(native / "capabilities", output / "capabilities", dirs_exist_ok=True)
    for config in native.glob("*.json"):
        shutil.copyfile(config, output / config.name)
    original = tomllib.loads((native / "Cargo.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((native / "Cargo.lock").read_text(encoding="utf-8"))
    (output / "Cargo.toml").write_text(make_manifest(original, lock), encoding="utf-8")
    shutil.copyfile(native / "Cargo.lock", output / "Cargo.lock")
    return lock


def verify_lock(original, generated):
    def identity(package):
        return tuple(package.get(key) for key in ("name", "version", "source", "checksum"))

    expected = {identity(package) for package in original["package"]}
    for package in generated["package"]:
        if package["name"] == "usage-ledger-native-headless" and "source" not in package:
            continue
        if identity(package) not in expected:
            raise ValueError(f'Dependency drift from production lock: {package["name"]} {package["version"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, help="Keep/reuse the generated harness and Cargo target here")
    parser.add_argument("--test-filter", help="Run only test names containing this text")
    parser.add_argument("--cargo", default="cargo", help="Cargo executable (default: cargo on PATH)")
    parser.add_argument("--offline", action="store_true", help="Require dependencies already in the Cargo cache")
    parser.add_argument("--generate-only", action="store_true", help="Generate sources without resolving/building/testing")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = (args.output or Path(tempfile.mkdtemp(prefix="usage-ledger-native-"))).resolve()
    original_lock = generate(repo, output)
    print(f"Headless native harness: {output}", flush=True)
    print("Excluded: desktop_shell and Tauri entry-point/macros; all business sources/tests retained.", flush=True)
    if args.generate_only:
        return
    cargo_args = ["--manifest-path", str(output / "Cargo.toml")]
    if args.offline:
        cargo_args.append("--offline")
    # Prune the copied lock for this generated workspace, then reject any change
    # to dependency versions/checksums before compiling or running the tests.
    subprocess.run([args.cargo, "update", "--workspace", "--quiet", *cargo_args], check=True)
    verify_lock(original_lock, tomllib.loads((output / "Cargo.lock").read_text(encoding="utf-8")))
    command = [args.cargo, "test", "--lib", "-j1", "--locked", *cargo_args]
    if args.test_filter:
        command.append(args.test_filter)
    command.extend(["--", "--test-threads=1"])
    with tempfile.TemporaryDirectory(prefix="usage-ledger-native-home-") as fixture:
        env = os.environ.copy()
        original_home = Path.home()
        env.setdefault("CARGO_HOME", str(original_home / ".cargo"))
        env.setdefault("RUSTUP_HOME", str(original_home / ".rustup"))
        for key in list(env):
            if key.startswith(("MONITOR_", "USAGE_MONITOR_", "USAGE_LEDGER_", "CODEX_MODE_LOG_")):
                env.pop(key)
        for key in ("COCKPIT_TOOLS_DATA_DIR", "COCKPIT_TOOLS_PROFILE", "CPA_TOKEN_USAGE_DIR", "CPA_MODEL_PRICE_FILE"):
            env.pop(key, None)
        for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
            env[key] = fixture
        for key, folder in (("CODEX_HOME", ".codex"), ("CLAUDE_CONFIG_DIR", ".claude"), ("DSH_HOME", ".dsh")):
            env[key] = str(Path(fixture) / folder)
        env["CONSOLE2API_LEDGER_DIR"] = str(Path(fixture) / "ledger")
        subprocess.run(command, env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
