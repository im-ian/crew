//! Whether Escape is already spoken for by an open layer.
//!
//! On macOS, `NSWindow` treats Escape as "leave fullscreen" once the key is
//! not used. The window tells us a layer is open, and the AppKit hook then
//! leaves that key to the page.

use std::sync::atomic::{AtomicBool, Ordering};

static LAYER_OPEN: AtomicBool = AtomicBool::new(false);

pub fn set_layer_open(open: bool) {
    LAYER_OPEN.store(open, Ordering::Relaxed);
}

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn layer_open() -> bool {
    LAYER_OPEN.load(Ordering::Relaxed)
}

/// Fullscreen stays when a layer is open. Otherwise Escape keeps the system meaning.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn swallow_escape(layer_open: bool, fullscreen: bool) -> bool {
    layer_open && fullscreen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_open_layer_keeps_fullscreen() {
        assert!(swallow_escape(true, true));
        assert!(!swallow_escape(false, true));
        assert!(!swallow_escape(true, false));
        assert!(!swallow_escape(false, false));
    }

    #[test]
    fn the_flag_follows_the_window() {
        let before = layer_open();
        set_layer_open(!before);
        assert_eq!(layer_open(), !before);
        set_layer_open(before);
    }
}
