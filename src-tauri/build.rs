fn main() {
    // The `objc` crate's `class!` and `msg_send!` macros check
    // `cfg(feature = "cargo-clippy")` internally. Register it as
    // a known cfg value so the compiler doesn't emit warnings.
    println!("cargo::rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");

    tauri_build::build()
}
