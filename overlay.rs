// overlay.rs — Transparent, always-on-top overlay window setup
//
// Windows: Uses WDA_EXCLUDEFROMCAPTURE (Win10 20H1 / build 19041+) to hide
//          the overlay from screen capture tools (Game Bar, OBS, Teams share).
// macOS:   Uses NSWindow.sharingType = .none (macOS 12+) and sets the window
//          level to floating so it sits above full-screen meeting windows.

use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    },
};

/// Configure the overlay window:
///  - Always on top
///  - Skip taskbar
///  - Transparent background (handled via Tauri window config)
///  - Hidden from screen capture where the OS supports it
pub fn setup_overlay_window(window: &WebviewWindow) {
    // Always on top is set in tauri.conf.json → windows[].alwaysOnTop
    // Here we handle the OS-level capture exclusion.
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        // Retrieve the raw HWND via the platform-specific handle
        if let Ok(hwnd) = window.hwnd() {
            exclude_from_capture_windows(HWND(hwnd.0));
        }
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        exclude_from_capture_macos(window);
    }
}

/// Remove the capture exclusion (e.g. on session stop).
pub fn restore_capture(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = SetWindowDisplayAffinity(HWND(hwnd.0), WDA_NONE);
            }
        }
    }
}

// ─── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn exclude_from_capture_windows(hwnd: HWND) {
    unsafe {
        match SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
            Ok(()) => log::info!("Overlay: WDA_EXCLUDEFROMCAPTURE applied"),
            Err(e) => {
                // Fallback: WDA_MONITOR makes window appear as black rect in captures
                log::warn!("WDA_EXCLUDEFROMCAPTURE failed ({}), falling back to WDA_MONITOR", e);
                // WDA_MONITOR = 0x00000001
                let _ = SetWindowDisplayAffinity(hwnd, windows::Win32::UI::WindowsAndMessaging::WDA_MONITOR);
            }
        }
    }
}

// ─── macOS implementation ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn exclude_from_capture_macos(window: &WebviewWindow) {
    use tauri::Manager;
    use objc2::runtime::Bool;

    // Access the underlying NSWindow via the raw window handle
    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            // setSharingType: 0 = NSWindowSharingNone  (macOS 12+)
            // The overlay will appear as a black rect or be absent in screenshots.
            let _: () = objc2::msg_send![
                ns_window as *mut objc2::runtime::AnyObject,
                setSharingType: 0_u64
            ];

            // NSWindowLevel.floating = 3 — sits above normal windows including
            // full-screen apps like Zoom and Teams.
            let _: () = objc2::msg_send![
                ns_window as *mut objc2::runtime::AnyObject,
                setLevel: 3_i64
            ];

            log::info!("Overlay: NSWindow.sharingType=none and floating level applied");
        }
    } else {
        log::warn!("Overlay: could not get NSWindow reference on macOS");
    }
}

// ─── Unsupported platform stub ────────────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn setup_overlay_window(_window: &WebviewWindow) {
    log::warn!("Overlay: screen capture hiding not supported on this platform");
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn restore_capture(_window: &WebviewWindow) {}
