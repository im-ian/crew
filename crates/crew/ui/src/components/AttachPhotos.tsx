import { useEffect, useState } from "react";
import { useT } from "../LocaleContext";
import { Play, X } from "../icons";
import { MediaPreview, type Shot } from "./MediaPreview";

/** A photo or clip waiting in the composer, in the order it was attached. */
export type AttachPhoto = {
  id: string;
  name: string;
  path: string;
  preview: string;
  media?: "video";
};

/**
 * Thumbnails above the composer. A press or Enter opens the same preview a
 * sent picture uses. The remove button sits outside that control, so taking
 * a file off does not open it.
 */
export function AttachPhotos({
  photos,
  onRemove,
}: {
  photos: AttachPhoto[];
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const index = photos.findIndex((a) => a.id === openId);
  // A chat switch swaps the row in place. Drop a preview whose file is gone,
  // so coming back does not open it again.
  useEffect(() => {
    if (openId && index < 0) setOpenId(null);
  }, [openId, index]);
  const shots: Shot[] = photos.map((a) => ({
    src: a.preview,
    alt: a.name,
    kind: a.media === "video" ? "video" : "image",
    path: a.path,
  }));
  return (
    <>
      <div className={"attach-photos" + (photos.length === 1 ? " is-one" : "")}>
        {photos.map((a) => (
          <div key={a.id} className="attach-photo">
            <button
              type="button"
              className="attach-photo-frame"
              aria-label={a.name}
              onClick={() => setOpenId(a.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setOpenId(a.id);
              }}
            >
              {a.media === "video" ? (
                <>
                  <video src={`${a.preview}#t=0.1`} muted playsInline preload="metadata" />
                  <span className="attach-play">
                    <Play size={12} className="md-media-play" />
                  </span>
                </>
              ) : (
                <img src={a.preview} alt="" />
              )}
            </button>
            <button
              type="button"
              className="attach-remove"
              title={t("composer.detach")}
              aria-label={t("composer.detachNamed", { name: a.name })}
              onClick={() => onRemove(a.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      {index >= 0 ? (
        <MediaPreview shots={shots} start={index} onClose={() => setOpenId(null)} />
      ) : null}
    </>
  );
}
