import { useLayoutEffect, useState, type RefObject } from "react";
import { guideRect } from "../guide";

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the guide sits over the stage, in px. The video is shown whole (object-fit: contain), and the guide is the
 * worker contract's guide rectangle of the video's own frame (86% of its width, at most 80% of its height) scaled onto
 * it. Before the video has a size, or with a scripted source, the stage itself is the frame.
 */
export function useGuideBox(
  stage: RefObject<HTMLElement | null>,
  video: RefObject<HTMLVideoElement | null>,
  watch: unknown
): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const cw = element.clientWidth;
      const ch = element.clientHeight;
      if (!cw || !ch) return;
      const vw = video.current?.videoWidth || cw;
      const vh = video.current?.videoHeight || ch;
      const scale = Math.min(cw / vw, ch / vh);
      const offX = (cw - vw * scale) / 2;
      const offY = (ch - vh * scale) / 2;
      const [x0, y0, x1, y1] = guideRect(vw, vh);
      setBox({
        left: offX + x0 * scale,
        top: offY + y0 * scale,
        width: (x1 - x0) * scale,
        height: (y1 - y0) * scale,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const v = video.current;
    v?.addEventListener("loadedmetadata", measure);
    v?.addEventListener("resize", measure); // the camera changed size, or the phone turned
    return () => {
      observer.disconnect();
      v?.removeEventListener("loadedmetadata", measure);
      v?.removeEventListener("resize", measure);
    };
  }, [stage, video, watch]);
  return box;
}
