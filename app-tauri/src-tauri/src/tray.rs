//! Menu bar / system tray. Aura lives here: closing the window only hides it,
//! and on macOS there's no Dock icon at all, so it stays out of the way like
//! other menu bar VPN clients.
//!
//! The connection state machine stays in the React UI (it keeps running while
//! the window is hidden). The tray just forwards clicks as events and the UI
//! pushes the current status back with `tray_update`.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const ICON_ON: &[u8] = include_bytes!("../icons/tray-connected.png");
const ICON_OFF: &[u8] = include_bytes!("../icons/tray-disconnected.png");

/// Handles to the pieces of the tray that change with connection state.
pub struct TrayState<R: Runtime> {
    icon: TrayIcon<R>,
    status: MenuItem<R>,
    toggle: MenuItem<R>,
    connected: Mutex<bool>,
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Disconnected", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Connect", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Aura", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Aura", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &quit,
        ],
    )?;

    let icon = TrayIconBuilder::with_id("aura")
        .icon(Image::from_bytes(ICON_OFF)?)
        // Template icons follow the menu bar's light/dark tint on macOS.
        .icon_as_template(true)
        .tooltip("Aura — Disconnected")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = app.emit("tray://toggle", ());
            }
            "open" => show_window(app),
            // Let the UI disconnect cleanly first; it calls `app_quit` when done.
            "quit" => {
                let _ = app.emit("tray://quit", ());
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows/Linux convention: left-click opens the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if !cfg!(target_os = "macos") {
                    show_window(tray.app_handle());
                }
            }
        })
        .build(app)?;

    app.manage(TrayState {
        icon,
        status,
        toggle,
        connected: Mutex::new(false),
    });
    Ok(())
}

pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Called by the UI whenever the connection status changes.
#[tauri::command]
pub fn tray_update<R: Runtime>(
    app: AppHandle<R>,
    status: String,
    connected: bool,
    busy: bool,
) -> Result<(), String> {
    let state = app.state::<TrayState<R>>();
    let err = |e: tauri::Error| e.to_string();
    state.status.set_text(&status).map_err(err)?;
    state
        .toggle
        .set_text(if connected { "Disconnect" } else if busy { "Connecting…" } else { "Connect" })
        .map_err(err)?;
    state.toggle.set_enabled(!busy).map_err(err)?;
    state.icon.set_tooltip(Some(format!("Aura — {status}"))).map_err(err)?;
    let mut was = state.connected.lock().unwrap();
    if *was != connected {
        *was = connected;
        let bytes = if connected { ICON_ON } else { ICON_OFF };
        state
            .icon
            .set_icon(Some(Image::from_bytes(bytes).map_err(err)?))
            .map_err(err)?;
        state.icon.set_icon_as_template(true).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
