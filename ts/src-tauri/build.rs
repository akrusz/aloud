fn main() {
  // tauri-build only declares tauri.conf.json and capabilities/, so cargo has
  // no idea these two are inputs - and both are baked in at compile time. A
  // dev run would keep using yesterday's icon set, or yesterday's usage
  // strings (the merged Info.plist is embedded in the binary itself, which is
  // what macOS reads when `tauri dev` runs it unbundled), with nothing to
  // suggest the edit hadn't landed.
  println!("cargo:rerun-if-changed=icons");
  println!("cargo:rerun-if-changed=Info.plist");
  tauri_build::build()
}
