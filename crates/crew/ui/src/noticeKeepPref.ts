import type { NoticeKeep } from "./island";

const KEY = "crew.noticeKeep";

/** Notices fade on their own unless the stored choice is exactly "keep". */
export function noticeKeepOf(stored: string | null): NoticeKeep {
  return stored === "keep" ? "keep" : "auto";
}

export function loadNoticeKeep(): NoticeKeep {
  try {
    return noticeKeepOf(localStorage.getItem(KEY));
  } catch {
    return "auto";
  }
}

export function saveNoticeKeep(keep: NoticeKeep) {
  try {
    localStorage.setItem(KEY, keep);
  } catch {
    /* private mode */
  }
}
