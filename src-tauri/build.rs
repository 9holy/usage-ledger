fn main() {
    tauri_build::build();
    // ponytail: tauri_build 默认只声明 rerun-if-changed=tauri.conf.json,
    // 不监听 frontendDist(../dist)。只改前端不改 conf 时,cargo 会复用旧 build script
    // 缓存 → exe 嵌入旧前端。显式监听 dist,前端变更即重跑 build script 重嵌资源。
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../dist/assets");
}
