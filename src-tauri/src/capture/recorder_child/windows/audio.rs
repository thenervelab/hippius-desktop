//! Sound: one WASAPI shared-mode client per device, each on its own thread.
//!
//! - **Microphone:** the capture endpoint the user chose (its endpoint id,
//!   from `--list-microphones`), or the default communications-or-console
//!   input.
//! - **System audio:** the default output endpoint in loopback, so what the
//!   computer plays is recorded (Hippius's own sounds included; leaving them
//!   out through Windows 11's process loopback is a later nicety).
//!
//! Each client is asked for 48 kHz stereo float with Windows' own converter
//! (`AUTOCONVERTPCM`); a driver that refuses gets its own mix format, which
//! [`pcm::Converter`] turns into the mixer's. Packets are stamped with
//! their QPC position (the clock WGC frames use), placed on the timeline and
//! sent to the writer. A device that goes away mid-recording ends its
//! thread only: the recording goes on without it (the mixer stops waiting
//! for a silent source after 300 ms), and stderr says so.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE, eCapture, eConsole, eRender,
};
use windows::Win32::Media::KernelStreaming::{SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};
use windows::core::{HSTRING, PCWSTR};

use super::super::mixer::{SAMPLE_RATE, Source};
use super::super::pcm::{self, Converter, Format};
use super::{Msg, Shared, com};

/// Which device to open.
#[derive(Debug, Clone)]
pub enum Device {
    /// A capture endpoint by id; `None` = the default input.
    Microphone(Option<String>),
    /// The default output, in loopback.
    SystemLoopback,
}

/// The WASAPI buffer: 200 ms, so a busy writer never makes a device drop
/// sound.
const BUFFER_HNS: i64 = 2_000_000;
/// How often a client is read: WASAPI's period is 10 ms.
const POLL: Duration = Duration::from_millis(10);

/// An opened, not yet started, device. COM objects are used only on the
/// thread [`spawn`] starts, which owns them from then on.
pub struct Opened {
    device: Device,
}

/// Check that `device` can be opened now, so a recording that cannot have
/// it leaves it out before the file is made. The client itself is opened
/// again on its own thread (COM objects stay on the thread that uses them).
pub fn open(device: Device) -> Result<Opened, String> {
    let _com = com::Apartment::enter();
    let client = Client::open(&device)?;
    drop(client);
    Ok(Opened { device })
}

/// Read `opened` until `stop`, sending its sound to the writer as `source`.
pub(crate) fn spawn(opened: Opened, source: Source, shared: Arc<Shared>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let _com = com::Apartment::enter();
        let client = match Client::open(&opened.device) {
            Ok(client) => client,
            Err(e) => {
                let _ = super::writeln_stderr(&format!("{source:?} could not be opened: {e}"));
                return;
            }
        };
        if let Err(e) = client.run(source, &shared, &stop) {
            let _ = super::writeln_stderr(&format!("{source:?} stopped, recording goes on without it: {e}"));
        }
    })
}

struct Client {
    audio: IAudioClient,
    capture: IAudioCaptureClient,
    converter: Converter,
}

impl Client {
    fn open(device: &Device) -> Result<Self, String> {
        // SAFETY: COM calls on objects created here, on a thread inside a
        // COM apartment; every out-pointer is a live local, the mix format
        // is freed with CoTaskMemFree as WASAPI requires.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("the audio devices: {e}"))?;
            let (endpoint, loopback): (IMMDevice, bool) = match device {
                Device::Microphone(Some(id)) => {
                    let id = HSTRING::from(id.as_str());
                    (
                        enumerator
                            .GetDevice(PCWSTR(id.as_ptr()))
                            .map_err(|e| format!("that microphone is not connected: {e}"))?,
                        false,
                    )
                }
                Device::Microphone(None) => (
                    enumerator
                        .GetDefaultAudioEndpoint(eCapture, eConsole)
                        .map_err(|e| format!("no microphone: {e}"))?,
                    false,
                ),
                Device::SystemLoopback => (
                    enumerator
                        .GetDefaultAudioEndpoint(eRender, eConsole)
                        .map_err(|e| format!("no speakers or headphones: {e}"))?,
                    true,
                ),
            };
            let audio: IAudioClient = endpoint.Activate(CLSCTX_ALL, None).map_err(|e| format!("opening the device: {e}"))?;
            let base = if loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            let wanted = mixer_format();
            let converted = audio.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                base | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                BUFFER_HNS,
                0,
                (&raw const wanted).cast::<WAVEFORMATEX>(),
                None,
            );
            let format = if converted.is_ok() {
                Format::MIXER
            } else {
                // Windows would not convert: take the device's own format.
                let audio_retry: IAudioClient = endpoint.Activate(CLSCTX_ALL, None).map_err(|e| format!("opening the device: {e}"))?;
                let mix = audio_retry.GetMixFormat().map_err(|e| format!("the device's format: {e}"))?;
                let format = format_of(mix);
                let init = audio_retry.Initialize(AUDCLNT_SHAREMODE_SHARED, base, BUFFER_HNS, 0, mix, None);
                CoTaskMemFree(Some(mix.cast()));
                init.map_err(|e| format!("starting the device: {e}"))?;
                let format = format.ok_or("the device's sound format is not one Hippius reads")?;
                let capture: IAudioCaptureClient = audio_retry.GetService().map_err(|e| format!("reading the device: {e}"))?;
                return Ok(Self {
                    audio: audio_retry,
                    capture,
                    converter: Converter::new(format),
                });
            };
            let capture: IAudioCaptureClient = audio.GetService().map_err(|e| format!("reading the device: {e}"))?;
            Ok(Self {
                audio,
                capture,
                converter: Converter::new(format),
            })
        }
    }

    fn run(mut self, source: Source, shared: &Shared, stop: &AtomicBool) -> Result<(), String> {
        // SAFETY: Start/Stop on the client this thread opened.
        unsafe { self.audio.Start() }.map_err(|e| format!("starting: {e}"))?;
        let frame_bytes = self.converter.format().frame_bytes();
        let result = (|| {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(POLL);
                loop {
                    // SAFETY: GetNextPacketSize / GetBuffer / ReleaseBuffer on
                    // this thread's capture client; `data` is read for exactly
                    // `frames * frame_bytes` bytes between GetBuffer and
                    // ReleaseBuffer, as WASAPI documents.
                    let packet = unsafe { self.capture.GetNextPacketSize() }.map_err(|e| format!("the device went away: {e}"))?;
                    if packet == 0 {
                        break;
                    }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    let mut qpc = 0u64;
                    unsafe {
                        self.capture
                            .GetBuffer(&raw mut data, &raw mut frames, &raw mut flags, None, Some(&raw mut qpc))
                            .map_err(|e| format!("the device went away: {e}"))?;
                    }
                    let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                    let samples = if silent || data.is_null() {
                        self.converter.silence(frames as usize)
                    } else {
                        // SAFETY: WASAPI hands out `frames` whole frames at `data`.
                        let bytes = unsafe { std::slice::from_raw_parts(data, frames as usize * frame_bytes) };
                        self.converter.convert(bytes)
                    };
                    unsafe { self.capture.ReleaseBuffer(frames) }.map_err(|e| format!("the device went away: {e}"))?;
                    // QPC positions are in 100 ns units.
                    let time = com::hns_to_micros(i64::try_from(qpc).unwrap_or(0));
                    if samples.is_empty() {
                        continue;
                    }
                    if let Some(placed) = shared.place(time)
                        && !shared.send(Msg::Audio {
                            source,
                            time: placed,
                            samples,
                        })
                    {
                        return Ok(());
                    }
                }
            }
            Ok(())
        })();
        // SAFETY: as above.
        let _ = unsafe { self.audio.Stop() };
        result
    }
}

/// 48 kHz stereo float, as `WAVEFORMATEXTENSIBLE`.
fn mixer_format() -> WAVEFORMATEXTENSIBLE {
    let block = 2 * 4;
    let mut format = WAVEFORMATEXTENSIBLE::default();
    format.Format.wFormatTag = pcm::WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = 2;
    format.Format.nSamplesPerSec = SAMPLE_RATE;
    format.Format.nAvgBytesPerSec = SAMPLE_RATE * block;
    format.Format.nBlockAlign = 8;
    format.Format.wBitsPerSample = 32;
    format.Format.cbSize = 22;
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    format
}

/// A device's own mix format, as the converter reads it.
///
/// # Safety
///
/// `mix` must point at a valid `WAVEFORMATEX` (and, when its tag says
/// extensible, a whole `WAVEFORMATEXTENSIBLE`), as `GetMixFormat` returns.
unsafe fn format_of(mix: *const WAVEFORMATEX) -> Option<Format> {
    // SAFETY: per this function's contract; read unaligned, as the struct is
    // packed.
    let base = unsafe { std::ptr::read_unaligned(mix) };
    let tag = base.wFormatTag;
    let float_subformat = if tag == pcm::WAVE_FORMAT_EXTENSIBLE {
        // SAFETY: an extensible tag promises the extensible struct.
        let ext = unsafe { std::ptr::read_unaligned(mix.cast::<WAVEFORMATEXTENSIBLE>()) };
        let sub = ext.SubFormat;
        sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    } else {
        tag == WAVE_FORMAT_IEEE_FLOAT as u16
    };
    pcm::format_from_wave(tag, base.wBitsPerSample, base.nChannels, base.nSamplesPerSec, float_subformat)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What is asked of every device is exactly what the mixer takes, so
    /// the converter is a copy.
    #[test]
    fn the_format_asked_for_is_the_mixers() {
        let f = mixer_format();
        // SAFETY: a fully initialised local, read as its base struct.
        let got = unsafe { format_of((&raw const f).cast()) };
        assert_eq!(got, Some(Format::MIXER));
    }
}
