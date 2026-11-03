//! Stop Escape from leaving macOS fullscreen while a layer is open.
//!
//! AppKit sends `cancelOperation:` for Escape, and `NSWindow` answers by
//! toggling fullscreen. The page may already be closing a preview or a
//! settings sheet with that same key. Swallow the toggle only then, and
//! call the original method the rest of the time.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};

use crate::escape_layer::{layer_open, swallow_escape};

/// `NSWindowStyleMaskFullScreen`.
const FULLSCREEN: usize = 1 << 14;

static ORIGINAL: OnceLock<Imp> = OnceLock::new();
static HOOKED: AtomicBool = AtomicBool::new(false);

pub fn install() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| match unsafe { hook_cancel_operation() } {
        Ok(()) => HOOKED.store(true, Ordering::Relaxed),
        Err(err) => eprintln!("crew: {err}"),
    });
}

#[cfg(test)]
fn hooked() -> bool {
    HOOKED.load(Ordering::Relaxed)
}

unsafe fn hook_cancel_operation() -> Result<(), String> {
    let Some(class) = AnyClass::get(c"NSWindow") else {
        return Err("NSWindow is missing".into());
    };
    let sel = sel!(cancelOperation:);
    let our: Imp = unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut c_void, Sel, *mut c_void), Imp>(
            cancel_operation,
        )
    };
    // A method NSWindow defines itself. Replacing a superclass method would
    // change every responder, so that case adds an override on NSWindow only.
    let owned = class.instance_methods();
    if let Some(method) = owned.iter().find(|method| method.name() == sel) {
        let previous = unsafe { method.set_implementation(our) };
        let _ = ORIGINAL.set(previous);
        return Ok(());
    }
    if let Some(parent) = class.superclass() {
        if let Some(method) = parent.instance_method(sel) {
            let _ = ORIGINAL.set(method.implementation());
        }
    }
    let added = unsafe {
        objc2::ffi::class_addMethod(
            std::ptr::from_ref(class).cast_mut(),
            sel,
            our,
            c"v@:@".as_ptr(),
        )
    };
    if added.as_bool() {
        Ok(())
    } else {
        Err("could not override NSWindow cancelOperation:".into())
    }
}

unsafe extern "C-unwind" fn cancel_operation(this: *mut c_void, cmd: Sel, sender: *mut c_void) {
    if !this.is_null() && swallow_escape(layer_open(), window_is_fullscreen(this)) {
        return;
    }
    let Some(original) = ORIGINAL.get().copied() else {
        return;
    };
    let call: unsafe extern "C-unwind" fn(*mut c_void, Sel, *mut c_void) =
        unsafe { std::mem::transmute(original) };
    unsafe { call(this, cmd, sender) };
}

unsafe fn window_is_fullscreen(window: *mut c_void) -> bool {
    let window: &AnyObject = unsafe { &*window.cast() };
    let mask: usize = unsafe { msg_send![window, styleMask] };
    mask & FULLSCREEN != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_hooks_cancel_operation() {
        install();
        install();
        assert!(hooked());
    }
}
