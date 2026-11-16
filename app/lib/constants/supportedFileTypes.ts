/**
 * Video extensions the viewer opens. The webview plays MP4/M4V/MOV/WebM/Ogg
 * itself; the rest are converted for the preview by Rust's video engine
 * (`src-tauri/src/video_engine/plan.rs`, `ENGINE_EXTENSIONS`, which this
 * list must cover). Plain `.ts` is left out: it is TypeScript far more often
 * than an MPEG transport stream.
 */
export const SUPPORTED_VIDEO_FORMATS = [
    "mp4",
    "m4v",
    "mov",
    "mkv",
    "webm",
    "3gp",
    "3g2",
    "ogg",
    "ogv",
    "wmv",
    "asf",
    "avi",
    "divx",
    "flv",
    "f4v",
    "mpg",
    "mpeg",
    "m2v",
    "vob",
    "m2ts",
    "mts",
    "m2t",
] as const;
