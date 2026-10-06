"use client";

import dynamic from "next/dynamic";
import EditorSkeleton from "./EditorSkeleton";

/**
 * The screenshot editor window (label `capture-editor`), opened by Rust from
 * the capture card's Edit or a Drive file's "Edit image". Boots without the
 * app's providers (`AppShell`), like every capture window.
 *
 * The editor itself is its own chunk: the route's first paint is the
 * skeleton, and the canvas code loads behind it.
 */
const EditorApp = dynamic(() => import("./EditorApp"), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

export default function CaptureEditorPage() {
  return <EditorApp />;
}
