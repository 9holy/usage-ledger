#!/usr/bin/env python3
"""Run DeepSeek fixture tests without GTK/Tauri desktop SDKs.

Copies actual store/pricing/catalog/live/analysis production sources; omits their
unrelated unit tests and catalog Tauri command wrappers. Uses actual collector,
parser and integration tests directly. Stubs ONLY quota initialization (not used
by this source), ledger clock (fixed test time), and ledger default-open (returns
an error so background catalog network refresh cannot run). No installed client
or real home/session directories are accessed. Requires Cargo and a C compiler.
Usage: python scripts/test-deepseek-headless.py [--output /tmp/dsh-check]
"""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
output = args.output or Path(tempfile.mkdtemp(prefix='usage-ledger-dsh-'))
output.mkdir(parents=True, exist_ok=True)
source = repo / 'src-tauri/src'
modules = output / 'src/usage_monitor'
modules.mkdir(parents=True, exist_ok=True)
for name in ['types', 'store', 'pricing', 'analysis', 'live']:
    text = (source / 'usage_monitor' / f'{name}.rs').read_text()
    (modules / f'{name}.rs').write_text(text.split('#[cfg(test)]')[0])
(output / 'src/model_catalog.rs').write_text((source / 'model_catalog.rs').read_text().split('#[tauri::command]')[0])
(output / 'Cargo.toml').write_text('''[package]
name="deepseek-backend-check"
version="0.1.0"
edition="2021"
[dependencies]
serde={version="1",features=["derive"]}
serde_json="1"
rusqlite={version="0.32",features=["bundled"]}
chrono={version="0.4",default-features=false,features=["std"]}
reqwest={version="0.13",default-features=false,features=["rustls","json","blocking"]}
md5="0.7"
zstd="0.13"
''')
lib = '''#![allow(dead_code, unused_imports)]
mod model_catalog;
mod ledger_db {
 pub fn now_ms()->i64 { 1800000000000 }
 pub fn open_default()->Result<rusqlite::Connection,String> { Err("headless test: catalog background refresh disabled".into()) }
}
mod usage_monitor {
 pub mod types;
 pub mod store;
 pub mod pricing;
 pub mod analysis;
 pub mod live;
 pub mod quota { pub fn initialize(_: &rusqlite::Connection)->Result<(),String>{Ok(())} }
'''
for name in ['deepseek_parser', 'deepseek', 'deepseek_tests']:
    # Copy source so paths with non-ASCII characters or Windows separators are safe.
    (modules / f'{name}.rs').write_text((source / 'usage_monitor' / f'{name}.rs').read_text())
    lib += (' #[cfg(test)]' if name == 'deepseek_tests' else '') + f' mod {name};\n'
lib += '}\n'
(output / 'src/lib.rs').write_text(lib)
print(f'Headless fixture harness: {output}', flush=True)
subprocess.run(['cargo', 'test', '--manifest-path', str(output / 'Cargo.toml')], check=True)
