# Vendored ConPTY

`conpty.dll` + `OpenConsole.exe` (x64) from the
[`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
NuGet package, version **1.25.260930003** (MIT, Microsoft-signed;
source: https://github.com/microsoft/terminal).

wmux loads this pair instead of the inbox `kernel32` ConPTY (see
`src/conpty.rs`). The inbox ConPTY drops escape sequences it does not
understand, including kitty graphics (APC `G`) and Sixel (DCS `q`); this
build passes them through, which image rendering in panes depends on.

Both files must ship together: `conpty.dll` starts the `OpenConsole.exe`
sitting next to it. `tauri.conf.json` bundles them beside `wmux.exe`.

| File | SHA-256 |
|---|---|
| `conpty.dll` | `feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a` |
| `OpenConsole.exe` | `3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586` |

To update: download the `.nupkg` from nuget.org, take
`runtimes/win-x64/native/conpty.dll` and
`build/native/runtimes/x64/OpenConsole.exe`, and update this table.
