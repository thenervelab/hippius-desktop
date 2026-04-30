import { atom } from "jotai";

/**
 * Mirror of the Rust `hcfs_upload_processing` event payload.
 * Owned by `crate::sync::upload_processing::UploadProcessingState` —
 * the FE never mutates this directly; it only reflects what Rust
 * emits.
 */
export interface UploadProcessingState {
  active: boolean;
  pendingFiles: number;
}

export const DEFAULT_UPLOAD_PROCESSING_STATE: UploadProcessingState = {
  active: false,
  pendingFiles: 0,
};

export const uploadProcessingAtom = atom<UploadProcessingState>(
  DEFAULT_UPLOAD_PROCESSING_STATE
);
