//! Installed Nerd Fonts, ordered for private-use icon fallback.
//!
//! A patched font such as JetBrains Mono also draws Latin and Hangul, so the
//! UI does not append the family itself. It registers each face through
//! `local()` and a private-use `unicode-range`. `local()` matches the full
//! name and the PostScript name, not the family, so both are returned.

/// `Symbols Nerd Font Mono`, then `Symbols Nerd Font`, then any other
/// installed family whose name contains "Nerd Font", in alphabetical order.
pub fn nerd_icon_families(families: &[impl AsRef<str>]) -> Vec<String> {
    const PREFERRED: &[&str] = &["Symbols Nerd Font Mono", "Symbols Nerd Font"];
    let names: Vec<&str> = families.iter().map(|name| name.as_ref()).collect();
    let mut chosen = Vec::new();
    for want in PREFERRED {
        if let Some(found) = names.iter().copied().find(|name| name.eq_ignore_ascii_case(want)) {
            push_unique(&mut chosen, found);
        }
    }
    let mut rest = Vec::new();
    for name in names {
        if !name.to_ascii_lowercase().contains("nerd font") {
            continue;
        }
        if chosen.iter().any(|have| have.eq_ignore_ascii_case(name)) {
            continue;
        }
        push_unique(&mut rest, name);
    }
    rest.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    chosen.extend(rest);
    chosen
}

/// Names CSS `local()` can match, full name first, then PostScript, then the
/// family. Empty and control-character names are dropped. Case-insensitive dupes too.
pub fn local_sources(family: &str, full: Option<&str>, postscript: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    for name in [full, postscript, Some(family)].into_iter().flatten() {
        let name = name.trim();
        if name.is_empty() || name.chars().any(|c| c.is_control()) {
            continue;
        }
        push_unique(&mut out, name);
    }
    out
}

fn push_unique(out: &mut Vec<String>, name: &str) {
    if out.iter().any(|have| have.eq_ignore_ascii_case(name)) {
        return;
    }
    out.push(name.to_string());
}

/// One inner list per face, in [`nerd_icon_families`] order.
pub fn installed_nerd_faces() -> Vec<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        return macos::faces();
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};

    use super::{local_sources, nerd_icon_families};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    pub fn faces() -> Vec<Vec<String>> {
        nerd_icon_families(&families())
            .into_iter()
            .map(|family| face_locals(&family))
            .filter(|locals| !locals.is_empty())
            .collect()
    }

    fn families() -> Vec<String> {
        let Some(cls) = AnyClass::get(c"NSFontManager") else {
            return Vec::new();
        };
        let manager: Option<Retained<AnyObject>> = unsafe { msg_send![cls, sharedFontManager] };
        let Some(manager) = manager else {
            return Vec::new();
        };
        let names: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*manager, availableFontFamilies] };
        let Some(names) = names else {
            return Vec::new();
        };
        let count: usize = unsafe { msg_send![&*names, count] };
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let item: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*names, objectAtIndex: index] };
            let Some(item) = item else {
                continue;
            };
            if let Some(name) = ns_utf8(&item) {
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
        out
    }

    fn face_locals(family: &str) -> Vec<String> {
        let (full, postscript) = font_names(family);
        local_sources(family, full.as_deref(), postscript.as_deref())
    }

    /// Full name (`displayName`) and PostScript name (`fontName`) of the
    /// regular face. `fontWithName:` accepts a family and returns that face.
    fn font_names(family: &str) -> (Option<String>, Option<String>) {
        let Some(nsstring) = AnyClass::get(c"NSString") else {
            return (None, None);
        };
        let Some(nsfont) = AnyClass::get(c"NSFont") else {
            return (None, None);
        };
        let Ok(c_family) = CString::new(family) else {
            return (None, None);
        };
        let name: Option<Retained<AnyObject>> =
            unsafe { msg_send![nsstring, stringWithUTF8String: c_family.as_ptr()] };
        let Some(name) = name else {
            return (None, None);
        };
        let font: Option<Retained<AnyObject>> =
            unsafe { msg_send![nsfont, fontWithName: &*name, size: 0.0_f64] };
        let Some(font) = font else {
            return (None, None);
        };
        let full: Option<Retained<AnyObject>> = unsafe { msg_send![&*font, displayName] };
        let postscript: Option<Retained<AnyObject>> = unsafe { msg_send![&*font, fontName] };
        (
            full.as_deref().and_then(ns_utf8),
            postscript.as_deref().and_then(ns_utf8),
        )
    }

    fn ns_utf8(value: &AnyObject) -> Option<String> {
        let ptr: *const i8 = unsafe { msg_send![value, UTF8String] };
        if ptr.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .ok()
            .map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_lead_and_a_name_without_nerd_font_stays_out() {
        let families = [
            "Menlo",
            "Monoplex KR Nerd",
            "JetBrainsMonoHangul Nerd Font Propo",
            "Symbols Nerd Font",
            "JetBrainsMonoHangul Nerd Font",
            "Symbols Nerd Font Mono",
        ];
        assert_eq!(
            nerd_icon_families(&families),
            vec![
                "Symbols Nerd Font Mono",
                "Symbols Nerd Font",
                "JetBrainsMonoHangul Nerd Font",
                "JetBrainsMonoHangul Nerd Font Propo",
            ]
        );
    }

    #[test]
    fn a_preferred_font_keeps_the_installed_spelling() {
        let families = ["symbols nerd font mono", "Hack Nerd Font", "hack nerd font"];
        assert_eq!(
            nerd_icon_families(&families),
            vec!["symbols nerd font mono".to_string(), "Hack Nerd Font".to_string()]
        );
    }

    #[test]
    fn local_names_prefer_the_full_name_and_skip_dupes() {
        assert_eq!(
            local_sources(
                "JetBrainsMonoHangul Nerd Font",
                Some("JetBrainsMonoHangul NF Regular"),
                Some("JetBrainsMonoHangulNF-Regular"),
            ),
            vec![
                "JetBrainsMonoHangul NF Regular",
                "JetBrainsMonoHangulNF-Regular",
                "JetBrainsMonoHangul Nerd Font",
            ]
        );
        assert_eq!(
            local_sources(
                "Symbols Nerd Font Mono",
                Some("Symbols Nerd Font Mono"),
                Some("SymbolsNFM"),
            ),
            vec!["Symbols Nerd Font Mono", "SymbolsNFM"]
        );
        assert!(local_sources("  ", Some("\n"), Some("")).is_empty());
    }

    #[test]
    fn listing_installed_faces_returns_clean_names() {
        for face in installed_nerd_faces() {
            assert!(!face.is_empty());
            assert!(face.iter().all(|name| !name.trim().is_empty()));
            assert!(face.iter().all(|name| !name.chars().any(|c| c.is_control())));
        }
    }
}
