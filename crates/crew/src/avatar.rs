use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use anyhow::Context;

use crate::config::empty_to_none;
use crate::paths;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

static DATA_URL_CACHE: Mutex<Vec<(String, u64, u64, String)>> = Mutex::new(Vec::new());

pub fn avatars_dir() -> PathBuf {
    paths::home_dir().join("avatars")
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

pub fn sniff_ext(bytes: &[u8], hint: Option<&str>) -> anyhow::Result<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Ok("png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok("jpg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Ok("webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("gif");
    }
    let extra = hint.map(|h| format!(" ({h})")).unwrap_or_default();
    anyhow::bail!("file is not a png, jpg, webp, or gif image{extra}");
}

pub fn decode_input(data: &str) -> anyhow::Result<Vec<u8>> {
    let data = data.trim();
    if data.is_empty() {
        anyhow::bail!("avatar data is empty");
    }
    let b64 = if let Some(rest) = data.split_once("base64,") {
        rest.1
    } else if data.starts_with("data:") {
        anyhow::bail!("avatar data URL is not base64");
    } else {
        data
    };
    b64_decode(b64).context("decode avatar")
}

pub fn install_from_bytes(
    agent_id: &str,
    bytes: &[u8],
    hint: Option<&str>,
) -> anyhow::Result<PathBuf> {
    if bytes.is_empty() {
        anyhow::bail!("avatar is empty");
    }
    if bytes.len() > MAX_BYTES {
        anyhow::bail!("avatar is larger than 8MB");
    }
    let ext = sniff_ext(bytes, hint)?;
    let dir = avatars_dir();
    fs::create_dir_all(&dir)?;
    clear_files(agent_id);
    let dest = dir.join(format!("{}.{ext}", paths::safe_agent_id(agent_id)));
    fs::write(&dest, bytes).with_context(|| format!("write {}", dest.display()))?;
    Ok(dest)
}

pub fn install_from_path(agent_id: &str, src: &str) -> anyhow::Result<PathBuf> {
    let src_path = paths::expand_tilde(src);
    if !src_path.is_file() {
        anyhow::bail!("avatar not found: {}", src_path.display());
    }
    let dest_dir = avatars_dir();
    if src_path.starts_with(&dest_dir) {
        let name = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if name == paths::safe_agent_id(agent_id) {
            return Ok(src_path);
        }
    }
    let bytes = fs::read(&src_path).with_context(|| format!("read {}", src_path.display()))?;
    let hint = src_path.file_name().and_then(|s| s.to_str());
    install_from_bytes(agent_id, &bytes, hint)
}

pub fn clear(agent_id: &str) {
    clear_files(agent_id);
}

pub fn copy_for(src_stored: Option<&str>, dest_id: &str) -> Option<String> {
    let src = src_stored.map(str::trim).filter(|s| !s.is_empty())?;
    install_from_path(dest_id, src)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn apply(
    cfg: &mut crate::config::AgentConfig,
    avatar: Option<String>,
    unset: bool,
) -> anyhow::Result<()> {
    if unset {
        clear(&cfg.id);
        cfg.avatar = None;
        return Ok(());
    }
    if let Some(src) = avatar.and_then(empty_to_none) {
        if src.starts_with("data:") {
            let bytes = decode_input(&src)?;
            let dest = install_from_bytes(&cfg.id, &bytes, None)?;
            cfg.avatar = Some(dest.to_string_lossy().into_owned());
        } else {
            let dest = install_from_path(&cfg.id, &src)?;
            cfg.avatar = Some(dest.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

pub fn data_url_for(stored: Option<&str>) -> Option<String> {
    let stored = stored.map(str::trim).filter(|s| !s.is_empty())?;
    if stored.starts_with("data:") {
        return Some(stored.to_string());
    }
    let path = paths::expand_tilde(stored);
    data_url_from_path(&path)
}

fn data_url_from_path(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    let key = path.display().to_string();
    if let Ok(cache) = DATA_URL_CACHE.lock() {
        if let Some((_, m, l, url)) = cache.iter().find(|(p, _, _, _)| p == &key) {
            if *m == mtime && *l == len {
                return Some(url.clone());
            }
        }
    }
    let bytes = fs::read(path).ok()?;
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let url = format!("data:{};base64,{}", mime_for_ext(ext), b64_encode(&bytes));
    if let Ok(mut cache) = DATA_URL_CACHE.lock() {
        cache.retain(|(p, _, _, _)| p != &key);
        cache.push((key, mtime, len, url.clone()));
        if cache.len() > 32 {
            cache.remove(0);
        }
    }
    Some(url)
}

fn clear_files(agent_id: &str) {
    let dir = avatars_dir();
    let safe = paths::safe_agent_id(agent_id);
    for ext in EXTS {
        let _ = fs::remove_file(dir.join(format!("{safe}.{ext}")));
    }
}

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < data.len() {
            out.push(T[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(T[(b2 & 63) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn b64_decode(input: &str) -> anyhow::Result<Vec<u8>> {
    fn val(c: u8) -> anyhow::Result<u8> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => anyhow::bail!("invalid base64"),
        }
    }
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if cleaned.len() % 4 != 0 {
        anyhow::bail!("invalid base64 length");
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks_exact(4) {
        let pad = (chunk[2] == b'=') as usize + (chunk[3] == b'=') as usize;
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { val(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { val(chunk[3])? };
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_magic() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0; 4]);
        assert_eq!(sniff_ext(&png, None).unwrap(), "png");
        assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0], None).unwrap(), "jpg");
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff_ext(&webp, None).unwrap(), "webp");
        assert_eq!(sniff_ext(b"GIF89a....", None).unwrap(), "gif");
        assert!(sniff_ext(b"not-an-image", Some("x.png")).is_err());
    }

    #[test]
    fn base64_roundtrip() {
        let src = b"\x89PNG\r\n\x1a\n hello";
        let enc = b64_encode(src);
        assert_eq!(b64_decode(&enc).unwrap(), src);
        let url = format!("data:image/png;base64,{enc}");
        assert_eq!(decode_input(&url).unwrap(), src);
    }

    #[test]
    fn mime_matches_ext() {
        assert_eq!(mime_for_ext("jpg"), "image/jpeg");
        assert_eq!(mime_for_ext("PNG"), "image/png");
    }
}
