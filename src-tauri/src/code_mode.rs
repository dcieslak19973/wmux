//! Code Mode — server-side JS execution of MCP tool orchestrations.
//!
//! Inspired by Cloudflare's Code Mode (blog.cloudflare.com/code-mode/). The
//! pitch: LLMs have been trained on far more code than synthetic tool-call
//! examples, so letting an agent write a *script* that calls our tools is
//! often more reliable than emitting N tool-call messages.
//!
//! Spike scope:
//!   * Pure Rust JS engine via boa_engine (slow but no native deps).
//!   * Five hand-picked tool bindings — read-heavy + a few mutators. Goal is
//!     to validate the ergonomics before binding everything.
//!   * Synchronous JS API: each binding blocks the script until the
//!     underlying async tool call returns. No Promises / `await`. Simpler
//!     for a spike; revisit when we add deno_core if the pattern proves out.
//!   * Hard timeout via boa's runtime limits + a wall clock check.
//!
//! Non-goals for the spike:
//!   * Full tool binding (all ~30 tools). Hand-pick proves the ergonomics.
//!   * TypeScript type generation. JSON in / JSON out, document in the
//!     tool description.
//!   * Reentrancy / concurrent script execution. One eval at a time per
//!     MCP request, multiple requests are independent.

use boa_engine::{
    js_string, Context, JsError, JsNativeError, JsResult, JsValue, NativeFunction, Source,
};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::task;

use crate::{control_bridge::FrontendControlBridge, session_manager::SessionManager};

/// Tools exposed to the sandbox in v0. Picked to cover the most natural
/// orchestration patterns (read layout → act on it). Easy to expand later
/// — just add to this list and the dispatcher works.
const EXPOSED_TOOLS: &[&str] = &[
    "list_workspaces",
    "list_tabs",
    "list_panes",
    "get_layout",
    "list_agents",
    "list_sessions",
    "ask_agent",
    "pane_send_text",
    "pane_send_keys",
    "pane_read_screen",
    "browser_list",
    "browser_open",
    "browser_navigate",
];

/// Execute a script and return its final value as a JSON string. Bindings
/// for the tools in `EXPOSED_TOOLS` are injected as global functions; each
/// takes one optional object argument (the MCP tool's input shape) and
/// returns the parsed JSON the tool would produce.
pub async fn eval_script(
    script: String,
    timeout_ms: u64,
    manager: SessionManager,
    app: tauri::AppHandle,
    bridge: FrontendControlBridge,
) -> Result<String, String> {
    let deadline_ms = timeout_ms.clamp(500, 300_000);

    // boa is sync and not Send across awaits — run it on a blocking thread.
    // Each tool binding will block_on the async dispatch_tool back through
    // the tokio runtime via Handle::current().
    let handle = tokio::runtime::Handle::current();
    task::spawn_blocking(move || run_blocking(script, deadline_ms, manager, app, bridge, handle))
        .await
        .map_err(|e| format!("code_mode worker panicked: {e}"))?
}

fn run_blocking(
    script: String,
    deadline_ms: u64,
    manager: SessionManager,
    app: tauri::AppHandle,
    bridge: FrontendControlBridge,
    handle: tokio::runtime::Handle,
) -> Result<String, String> {
    let mut ctx = Context::default();
    let started = Instant::now();
    let deadline = started + Duration::from_millis(deadline_ms);

    for tool in EXPOSED_TOOLS {
        let tool_name = (*tool).to_string();
        let manager = manager.clone();
        let app = app.clone();
        let bridge = bridge.clone();
        let handle = handle.clone();

        // SAFETY: the closure captures only `'static` Rust state (clones of
        // AppHandle, SessionManager, FrontendControlBridge, Handle, and a
        // String). None of these are Boa-managed `Trace` values, so the GC
        // never needs to traverse them. This satisfies the invariant
        // documented on `NativeFunction::from_closure`.
        let native = unsafe {
            NativeFunction::from_closure(move |_this, args, ctx| {
                tool_native(
                    &tool_name,
                    args,
                    ctx,
                    &manager,
                    &app,
                    &bridge,
                    &handle,
                    deadline,
                )
            })
        };
        ctx.register_global_callable(js_string!(*tool), 1, native)
            .map_err(|e| format!("failed to register {tool}: {e}"))?;
    }

    // Expose a `console.log(...)` that captures into a buffer — collected
    // and returned alongside the script result so agents can debug.
    // (Boa has no console by default.) For the spike we just throw away
    // console output; can add capture later.
    let console_log = unsafe {
        NativeFunction::from_closure(|_this, _args, _ctx| Ok(JsValue::undefined()))
    };
    let console = boa_engine::object::ObjectInitializer::new(&mut ctx)
        .function(console_log, js_string!("log"), 0)
        .build();
    ctx.register_global_property(js_string!("console"), console, boa_engine::property::Attribute::all())
        .map_err(|e| format!("failed to register console: {e}"))?;

    let result = ctx
        .eval(Source::from_bytes(script.as_bytes()))
        .map_err(|e| format!("script error: {}", format_js_error(&e, &mut ctx)))?;

    // Run queued microtasks (none in v0 since we're sync, but harmless).
    ctx.run_jobs();

    if started.elapsed() > Duration::from_millis(deadline_ms) {
        return Err(format!("script exceeded {deadline_ms}ms"));
    }

    let json = result
        .to_json(&mut ctx)
        .map_err(|e| format!("could not serialize script result to JSON: {}", format_js_error(&e, &mut ctx)))?;
    serde_json::to_string_pretty(&json).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn tool_native(
    tool_name: &str,
    args: &[JsValue],
    ctx: &mut Context,
    manager: &SessionManager,
    app: &tauri::AppHandle,
    bridge: &FrontendControlBridge,
    handle: &tokio::runtime::Handle,
    deadline: Instant,
) -> JsResult<JsValue> {
    if Instant::now() >= deadline {
        return Err(JsNativeError::error()
            .with_message("script deadline exceeded")
            .into());
    }

    // First arg, if present, becomes the tool input. Missing → empty {}.
    let tool_args_json = match args.first() {
        Some(v) if !v.is_undefined() && !v.is_null() => v.to_json(ctx)?,
        _ => Value::Object(serde_json::Map::new()),
    };

    // Synchronous bridge back to the async runtime. block_on inside
    // spawn_blocking is safe — we're already off the runtime worker thread.
    let result = handle.block_on(crate::http_server::dispatch_tool(
        tool_name,
        &tool_args_json,
        manager,
        app,
        bridge,
    ));

    match result {
        Ok(s) => {
            // dispatch_tool returns a pre-formatted JSON string. Re-parse so
            // the script sees structured data, not a string.
            let parsed: Value = serde_json::from_str(&s).unwrap_or(Value::String(s));
            JsValue::from_json(&parsed, ctx)
        }
        Err(msg) => Err(JsNativeError::error()
            .with_message(format!("{tool_name}: {msg}"))
            .into()),
    }
}

fn format_js_error(err: &JsError, ctx: &mut Context) -> String {
    err.to_string()
        + " "
        + &err
            .try_native(ctx)
            .map(|n| format!("{n:?}"))
            .unwrap_or_default()
}
