//! Rust port of the [`cefsimple`](https://github.com/chromiumembedded/cef/tree/master/tests/cefsimple) example.

use cef::*;

pub mod resources;
pub mod simple_app;
pub mod simple_handler;

#[cfg(target_os = "macos")]
pub type Library = library_loader::LibraryLoader;

#[cfg(not(target_os = "macos"))]
pub struct Library;

#[allow(dead_code)]
pub fn load_cef() -> Library {
    #[cfg(target_os = "macos")]
    let library = {
        let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), false);
        assert!(loader.load());
        loader
    };
    #[cfg(not(target_os = "macos"))]
    let library = Library;

    // Initialize the CEF API version.
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    #[cfg(target_os = "macos")]
    crate::mac::setup_simple_application();

    library
}

#[allow(dead_code)]
pub fn run_main(main_args: &MainArgs, cmd_line: &CommandLine, sandbox_info: *mut u8) {
    let switch = CefString::from("type");
    let is_browser_process = cmd_line.has_switch(Some(&switch)) != 1;

    let ret = execute_process(Some(main_args), None, sandbox_info);

    if is_browser_process {
        println!("launch browser process");
        assert_eq!(ret, -1, "cannot execute browser process");
    } else {
        let process_type = CefString::from(&cmd_line.switch_value(Some(&switch)));
        println!("launch process {process_type}");
        assert!(ret >= 0, "cannot execute non-browser process");
        // non-browser process does not initialize cef
        return;
    }

    let mut app = simple_app::SimpleApp::new();

    // Optional per-launch isolation: when wmux spawns this helper for a pane,
    // it can pass `--user-data-dir=<path>` so each helper has its own cache /
    // cookies / lock file. Without it, multiple helper instances (or a crashed
    // one followed by a fresh one) collide on the default CEF data dir and
    // the second launch panics with `initialize() == 0`.
    let user_data_dir =
        CefString::from(&cmd_line.switch_value(Some(&CefString::from("user-data-dir"))))
            .to_string();
    let root_cache_path = if user_data_dir.is_empty() {
        CefString::default()
    } else {
        println!("using --user-data-dir={user_data_dir}");
        CefString::from(user_data_dir.as_str())
    };

    let settings = Settings {
        no_sandbox: !cfg!(feature = "sandbox") as _,
        root_cache_path,
        ..Default::default()
    };
    assert_eq!(
        initialize(
            Some(main_args),
            Some(&settings),
            Some(&mut app),
            sandbox_info,
        ),
        1
    );

    #[cfg(target_os = "macos")]
    let _delegate = crate::mac::setup_simple_app_delegate();

    run_message_loop();

    shutdown();
}
