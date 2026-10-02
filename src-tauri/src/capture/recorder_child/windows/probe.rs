//! `--probe`: what this Windows can record with, as one JSON object. The
//! app asks the same questions in its own process
//! ([`crate::capture::recording::windows`], cached once per launch), so
//! Record shows the right reason before anything is started.
//!
//! Windows N and KN editions ship without the H.264 and AAC encoders until
//! the Media Feature Pack is added; `MFTEnumEx` finds none there.

use serde::Serialize;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFAudioFormat_AAC, MFMediaType_Audio, MFMediaType_Video, MFT_CATEGORY_AUDIO_ENCODER, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_ASYNCMFT, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_REGISTER_TYPE_INFO, MFTEnumEx,
    MFVideoFormat_H264,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::core::GUID;

use super::com;

/// What `--probe` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub build: Option<u32>,
    /// Build 19041 or later: WGC's cursor control and capture exclusion.
    pub os_supported: bool,
    pub h264_encoder: bool,
    pub aac_encoder: bool,
    /// A hardware H.264 encoder is present (else the software one is used).
    pub hardware_h264: bool,
}

impl Probe {
    /// Both encoders are present.
    #[must_use]
    pub const fn encoders(&self) -> bool {
        self.h264_encoder && self.aac_encoder
    }
}

/// Ask Windows.
pub fn probe() -> Probe {
    use crate::capture::permissions::{windows_build, windows_excludes_from_capture};
    let _com = com::Apartment::enter();
    let _media = com::MediaFoundation::start();
    let build = windows_build();
    let any = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER;
    Probe {
        build,
        os_supported: windows_excludes_from_capture(build),
        h264_encoder: count(MFT_CATEGORY_VIDEO_ENCODER, MFMediaType_Video, MFVideoFormat_H264, any) > 0,
        aac_encoder: count(MFT_CATEGORY_AUDIO_ENCODER, MFMediaType_Audio, MFAudioFormat_AAC, any) > 0,
        hardware_h264: count(MFT_CATEGORY_VIDEO_ENCODER, MFMediaType_Video, MFVideoFormat_H264, MFT_ENUM_FLAG_HARDWARE) > 0,
    }
}

/// How many encoders of `category` produce `subtype`.
fn count(category: GUID, major: GUID, subtype: GUID, flags: windows::Win32::Media::MediaFoundation::MFT_ENUM_FLAG) -> u32 {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: major,
        guidSubtype: subtype,
    };
    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut n = 0u32;
    // SAFETY: valid out-pointers; the array MFTEnumEx allocates is released
    // element by element and then freed with CoTaskMemFree, as documented.
    unsafe {
        if MFTEnumEx(category, flags, None, Some(&raw const output), &raw mut activates, &raw mut n).is_err() {
            return 0;
        }
        if !activates.is_null() {
            for i in 0..n as usize {
                drop(std::ptr::read(activates.add(i)));
            }
            CoTaskMemFree(Some(activates.cast()));
        }
    }
    n
}
