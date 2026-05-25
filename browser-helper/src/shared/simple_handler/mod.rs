use cef::*;
use std::sync::{Arc, Mutex, OnceLock, Weak};

fn get_data_uri(data: &[u8], mime_type: &str) -> String {
    let data = CefString::from(&base64_encode(Some(data)));
    let uri = CefString::from(&uriencode(Some(&data), 0)).to_string();
    format!("data:{mime_type};base64,{uri}")
}

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac::*;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "windows")]
use win::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::*;

#[cfg(not(target_os = "macos"))]
fn platform_show_window(_browser: Option<&mut Browser>) {
    todo!("Implement platform_show_window for non-macOS platforms");
}

static SIMPLE_HANDLER_INSTANCE: OnceLock<Weak<Mutex<SimpleHandler>>> = OnceLock::new();

pub struct SimpleHandler {
    is_alloy_style: bool,
    browser_list: Vec<Browser>,
    is_closing: bool,
    weak_self: Weak<Mutex<Self>>,
}

impl SimpleHandler {
    pub fn instance() -> Option<Arc<Mutex<Self>>> {
        SIMPLE_HANDLER_INSTANCE
            .get()
            .and_then(|weak| weak.upgrade())
    }

    pub fn new(is_alloy_style: bool) -> Arc<Mutex<Self>> {
        Arc::new_cyclic(|weak| {
            if let Err(instance) = SIMPLE_HANDLER_INSTANCE.set(weak.clone()) {
                assert_eq!(instance.strong_count(), 0, "Replacing a viable instance");
            }

            Mutex::new(Self {
                is_alloy_style,
                browser_list: Vec::new(),
                is_closing: false,
                weak_self: weak.clone(),
            })
        })
    }

    fn on_title_change(&mut self, browser: Option<&mut Browser>, title: Option<&CefString>) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);

        let mut browser = browser.cloned();
        if let Some(browser_view) = browser_view_get_for_browser(browser.as_mut()) {
            if let Some(window) = browser_view.window() {
                window.set_title(title);
            }
        } else if self.is_alloy_style {
            platform_title_change(browser.as_mut(), title);
        }
    }

    fn on_after_created(&mut self, browser: Option<&mut Browser>) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);

        let browser = browser.cloned().expect("Browser is None");

        // Sanity-check the configured runtime style.
        assert_eq!(
            browser.host().expect("BrowserHost is None").runtime_style(),
            if self.is_alloy_style {
                RuntimeStyle::ALLOY
            } else {
                RuntimeStyle::CHROME
            }
        );

        // SPIKE: bring CEF window to top of Z-order so it isn't hidden behind
        // wmux's webview HWND (we're a sibling of the webview under wmux's
        // main HWND, and default z-order leaves the more-recently-active
        // window on top — that's typically the webview because the user
        // clicks wmux UI). Without this the CEF window is alive and rendering
        // but completely covered, which is what made the spike's google.com
        // tests look like everything was broken.
        //
        // When --offscreen is set (Path B embedded mode), we also yank the
        // window way off-screen so the user doesn't see the standalone
        // top-level window. The renderer still composes normally; we capture
        // its output via CDP Page.startScreencast and draw to a canvas in a
        // wmux pane. This is the "OSR via screencast" spike — a stepping
        // stone toward true CEF OSR.
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
                GWL_EXSTYLE, HWND_TOP, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
                WS_EX_LAYERED, WS_EX_TOOLWINDOW,
            };
            let cef_hwnd = browser
                .host()
                .expect("BrowserHost is None")
                .window_handle();
            // cef::sys::HWND wraps a `*mut HWND__`; pull out the inner pointer
            // and re-cast to windows_sys's HWND alias.
            let raw: *mut std::ffi::c_void = cef_hwnd.0 as *mut std::ffi::c_void;
            let offscreen = command_line_get_global()
                .map(|cl| cl.has_switch(Some(&CefString::from("offscreen"))) != 0)
                .unwrap_or(false);
            unsafe {
                if offscreen {
                    // 1. Tool window — removes from Alt-Tab / taskbar.
                    // 2. Layered — lets us set per-window alpha. Setting
                    //    alpha to 0 makes the window fully transparent
                    //    regardless of position. Chromium can re-move the
                    //    window during navigation (we observed it pulling
                    //    the window back near the screen origin on link
                    //    clicks); with alpha=0 the user never sees it
                    //    wherever it ends up.
                    // 3. Position offscreen anyway — defense in depth,
                    //    and saves the OS some compositor work.
                    let ex = GetWindowLongPtrW(raw, GWL_EXSTYLE);
                    SetWindowLongPtrW(
                        raw,
                        GWL_EXSTYLE,
                        ex | (WS_EX_TOOLWINDOW as isize) | (WS_EX_LAYERED as isize),
                    );
                    SetLayeredWindowAttributes(raw, 0, 0, LWA_ALPHA);
                    SetWindowPos(raw, HWND_TOP, -30000, -30000, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
                } else {
                    SetWindowPos(raw, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
        }

        // Add to the list of existing browsers.
        self.browser_list.push(browser);
    }

    fn do_close(&mut self, _browser: Option<&mut Browser>) -> bool {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);

        // Closing the main window requires special handling. See the DoClose()
        // documentation in the CEF header for a detailed destription of this
        // process.
        if self.browser_list.len() == 1 {
            // Set a flag to indicate that the window close should be allowed.
            self.is_closing = true;
        }

        // Allow the close. For windowed browsers this will result in the OS close
        // event being sent.
        false
    }

    fn on_before_close(&mut self, browser: Option<&mut Browser>) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);

        // Remove from the list of existing browsers.
        let mut browser = browser.cloned().expect("Browser is None");
        if let Some(index) = self
            .browser_list
            .iter()
            .position(move |elem| elem.is_same(Some(&mut browser)) != 0)
        {
            self.browser_list.remove(index);
        }

        if self.browser_list.is_empty() {
            // All browser windows have closed. Quit the application message loop.
            quit_message_loop();
        }
    }

    fn on_load_error(
        &mut self,
        _browser: Option<&mut Browser>,
        frame: Option<&mut Frame>,
        error_code: Errorcode,
        error_text: Option<&CefString>,
        failed_url: Option<&CefString>,
    ) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);

        // Allow Chrome to show the error page.
        if !self.is_alloy_style {
            return;
        }

        // Don't display an error for downloaded files.
        let error_code = sys::cef_errorcode_t::from(error_code);
        if error_code == sys::cef_errorcode_t::ERR_ABORTED {
            return;
        }
        let error_code = error_code as i32;

        let frame = frame.expect("Frame is None");

        // Display a load error message using a data: URI.
        let error_text = error_text.map(CefString::to_string).unwrap_or_default();
        let failed_url = failed_url.map(CefString::to_string).unwrap_or_default();
        let data = format!(
            r#"
            <html>
                <body bgcolor="white">
                    <h2>Failed to load URL {failed_url} with error {error_text} ({error_code}).</h2>
                </body>
            </html>
            "#
        );

        let uri = get_data_uri(data.as_bytes(), "text/html");
        let uri = CefString::from(uri.as_str());
        frame.load_url(Some(&uri));
    }

    pub fn show_main_window(&mut self) {
        let thread_id = ThreadId::UI;
        if currently_on(thread_id) == 0 {
            // Execute on the UI thread.
            let this = self
                .weak_self
                .upgrade()
                .expect("Weak reference to SimpleHandler is None");
            let mut task = ShowMainWindow::new(this);
            post_task(thread_id, Some(&mut task));
            return;
        }

        let Some(mut main_browser) = self.browser_list.first().cloned() else {
            return;
        };

        if let Some(browser_view) = browser_view_get_for_browser(Some(&mut main_browser)) {
            // Show the window using the Views framework.
            if let Some(window) = browser_view.window() {
                window.show();
            }
        } else if self.is_alloy_style {
            platform_show_window(Some(&mut main_browser));
        }
    }

    pub fn close_all_browsers(&mut self, force_close: bool) {
        let thread_id = ThreadId::UI;
        if currently_on(thread_id) == 0 {
            // Execute on the UI thread.
            let this = self
                .weak_self
                .upgrade()
                .expect("Weak reference to SimpleHandler is None");
            let mut task = CloseAllBrowsers::new(this, force_close);
            post_task(thread_id, Some(&mut task));
            return;
        }

        for browser in self.browser_list.iter() {
            let browser_host = browser.host().expect("BrowserHost is None");
            browser_host.close_browser(force_close.into());
        }
    }

    pub fn is_closing(&self) -> bool {
        self.is_closing
    }
}

wrap_client! {
    pub struct SimpleHandlerClient {
        inner: Arc<Mutex<SimpleHandler>>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(SimpleHandlerDisplayHandler::new(self.inner.clone()))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(SimpleHandlerLifeSpanHandler::new(self.inner.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(SimpleHandlerLoadHandler::new(self.inner.clone()))
        }
    }
}

wrap_display_handler! {
    struct SimpleHandlerDisplayHandler {
        inner: Arc<Mutex<SimpleHandler>>,
    }

    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.on_title_change(browser, title);
        }
    }
}

wrap_life_span_handler! {
    struct SimpleHandlerLifeSpanHandler {
        inner: Arc<Mutex<SimpleHandler>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.on_after_created(browser);
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.do_close(browser).into()
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.on_before_close(browser);
        }

        // Intercept popup creation when running offscreen. Without this,
        // clicks on links with target=_blank (e.g. every Google search
        // result) cause CEF to open a brand-new top-level Chromium window
        // — which doesn't inherit --offscreen, so it shows in the taskbar
        // and isn't captured by our screencast. We cancel the popup and
        // load the target URL in the current main frame instead, so the
        // canvas sees the navigation.
        //
        // Only applies when --offscreen is in effect — legitimate popup
        // usage (OAuth windows, devtools, etc.) is preserved for the
        // standalone CEF helper path.
        fn on_before_popup(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            let offscreen = command_line_get_global()
                .map(|cl| cl.has_switch(Some(&CefString::from("offscreen"))) != 0)
                .unwrap_or(false);
            if !offscreen {
                // Standalone helper path — keep CEF's default behavior
                // (create a separate top-level window for popups).
                return 0;
            }
            if let (Some(browser), Some(url)) = (browser, target_url) {
                if let Some(main_frame) = browser.main_frame() {
                    main_frame.load_url(Some(url));
                }
            }
            1 // cancel popup
        }
    }
}

wrap_load_handler! {
    struct SimpleHandlerLoadHandler {
        inner: Arc<Mutex<SimpleHandler>>,
    }

    impl LoadHandler {
        fn on_load_error(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.on_load_error(browser, frame, error_code, error_text, failed_url);
        }
    }
}

wrap_task! {
    struct ShowMainWindow {
        inner: Arc<Mutex<SimpleHandler>>,
    }

    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);

            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.show_main_window();
        }
    }
}

wrap_task! {
    struct CloseAllBrowsers {
        inner: Arc<Mutex<SimpleHandler>>,
        force_close: bool,
    }

    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);

            let mut inner = self.inner.lock().expect("Failed to lock inner");
            inner.close_all_browsers(self.force_close);
        }
    }
}
