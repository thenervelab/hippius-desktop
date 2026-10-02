//! Sound: one WASAPI shared-mode client per device, each on its own thread.
//!
//! - **Microphone:** the capture endpoint the user chose (its endpoint id,
//!   from `--list-microphones`), or the default communications-or-console
//!   input.
//! - **System audio:** on Windows 11, process loopback of everything the
//!   computer plays EXCEPT the app's own process tree
//!   (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on the pid the app
//!   passes in [`APP_PID_ENV`]), so Hippius's own sounds stay out of the
//!   recording. Older builds, a child driven by hand, or a refusal fall back
//!   to loopback of the default output ([`sources::system_audio_route`]).
//! - **The meter** (`--meter`): the same microphone client, read for its
//!   level only ([`run_meter`]).
//!
//! Each client is asked for 48 kHz stereo float with Windows' own converter
//! (`AUTOCONVERTPCM`); a driver that refuses gets its own mix format, which
//! [`pcm::Converter`] turns into the mixer's. Packets are stamped with
//! their QPC position (the clock WGC frames use), placed on the timeline and
//! sent to the writer. A device that goes away mid-recording ends its
//! thread only: the recording goes on without it (the mixer stops waiting
//! for a silent source after 300 ms), stderr says so, and the app is told
//! (`device_lost`) so the pill can say it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, eCapture, eConsole,
    eRender,
};
use windows::Win32::Media::KernelStreaming::{SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{BLOB, CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HRESULT, HSTRING, IUnknown, Interface, PCWSTR};

use super::super::meter;
use super::super::mixer::{SAMPLE_RATE, Source};
use super::super::pcm::{self, Converter, Format, SampleFormat};
use super::super::sources::{self, APP_PID_ENV, SystemAudioRoute};
use super::{Msg, Shared, com};

/// Which device to open.
#[derive(Debug, Clone)]
pub enum Device {
    /// A capture endpoint by id; `None` = the default input.
    Microphone(Option<String>),
    /// What the computer plays, by [`SystemAudioRoute`].
    System(SystemAudioRoute),
}

impl Device {
    /// System audio as this machine records it: the app's own tree left out
    /// where Windows can ([`sources::system_audio_route`]).
    pub fn system() -> Self {
        let pid = sources::app_pid_from(std::env::var(APP_PID_ENV).ok().as_deref());
        Self::System(sources::system_audio_route(crate::capture::permissions::windows_build(), pid))
    }
}

/// The WASAPI buffer: 200 ms, so a busy writer never makes a device drop
/// sound.
const BUFFER_HNS: i64 = 2_000_000;
/// How often a client is read: WASAPI's period is 10 ms.
const POLL: Duration = Duration::from_millis(10);
/// How long Windows may take to hand over a process-loopback client.
const ACTIVATE_WITHIN: Duration = Duration::from_secs(5);

/// An opened, not yet started, device. COM objects are used only on the
/// thread [`spawn`] starts, which owns them from then on.
pub struct Opened {
    device: Device,
}

/// Check that `device` can be opened now, so a recording that cannot have
/// it leaves it out before the file is made. The client itself is opened
/// again on its own thread (COM objects stay on the thread that uses them).
/// A system route that Windows refuses is replaced by the whole output here,
/// so the thread opens what was checked.
pub fn open(device: Device) -> Result<Opened, String> {
    let _com = com::Apartment::enter();
    match Client::open(&device) {
        Ok(client) => {
            drop(client);
            Ok(Opened { device })
        }
        Err(e) if matches!(device, Device::System(SystemAudioRoute::ExcludingProcessTree { .. })) => {
            let _ = super::writeln_stderr(&format!(
                "system audio without Hippius's own sounds is not available, recording all of it: {e}"
            ));
            open(Device::System(SystemAudioRoute::WholeOutput))
        }
        Err(e) => Err(e),
    }
}

/// Read `opened` until `stop`, sending its sound to the writer as `source`.
/// `on_lost` is called once if the device goes away mid-recording.
pub(crate) fn spawn(
    opened: Opened,
    source: Source,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    on_lost: impl FnOnce(&str) + Send + 'static,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let _com = com::Apartment::enter();
        let client = match Client::open(&opened.device) {
            Ok(client) => client,
            Err(e) => {
                let _ = super::writeln_stderr(&format!("{source:?} could not be opened: {e}"));
                on_lost(&e);
                return;
            }
        };
        let result = client.read(&stop, |time, samples| match shared.place(time) {
            Some(placed) => shared.send(Msg::Audio {
                source,
                time: placed,
                samples,
            }),
            None => true,
        });
        if let Err(e) = result {
            let _ = super::writeln_stderr(&format!("{source:?} stopped, recording goes on without it: {e}"));
            on_lost(&e);
        }
    })
}

/// `--meter [deviceId]`: open the microphone and print its level until
/// stdin closes (see [`meter`]). The device is opened on this thread, inside
/// its COM apartment, and let go as soon as stdin closes, before the
/// recorder can want it.
pub fn run_meter(device: Option<String>) -> i32 {
    let _com = com::Apartment::enter();
    meter::serve(std::io::BufReader::new(std::io::stdin()), std::io::stdout(), move || {
        let client = Client::open(&Device::Microphone(device))?;
        let reader: meter::Reader = Box::new(move |stop, sink| {
            client.read(stop, |_, samples| {
                sink(&samples);
                true
            })
        });
        Ok(reader)
    })
}

struct Client {
    audio: IAudioClient,
    capture: IAudioCaptureClient,
    converter: Converter,
    /// Signalled when a packet is ready, for a client opened in event mode
    /// (process loopback); polled otherwise.
    ready: Option<Event>,
}

/// A Win32 event, closed on drop.
struct Event(HANDLE);

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateEventW and is closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

impl Client {
    fn open(device: &Device) -> Result<Self, String> {
        match device {
            Device::Microphone(id) => {
                let endpoint = endpoint(device_endpoint(id.as_deref()))?;
                Self::open_endpoint(&endpoint, false)
            }
            Device::System(SystemAudioRoute::WholeOutput) => {
                let endpoint = endpoint(EndpointChoice::DefaultOutput)?;
                Self::open_endpoint(&endpoint, true)
            }
            Device::System(SystemAudioRoute::ExcludingProcessTree { pid }) => Self::open_process_loopback(*pid),
        }
    }

    /// A capture endpoint, or (loopback) a render endpoint read back.
    fn open_endpoint(endpoint: &IMMDevice, loopback: bool) -> Result<Self, String> {
        // SAFETY: COM calls on objects created here, on a thread inside a
        // COM apartment; every out-pointer is a live local, the mix format
        // is freed with CoTaskMemFree as WASAPI requires.
        unsafe {
            let audio: IAudioClient = endpoint.Activate(CLSCTX_ALL, None).map_err(|e| format!("opening the device: {e}"))?;
            let base = if loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            let wanted = wave_format(Format::MIXER);
            let converted = audio.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                base | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                BUFFER_HNS,
                0,
                (&raw const wanted).cast::<WAVEFORMATEX>(),
                None,
            );
            if converted.is_ok() {
                let capture: IAudioCaptureClient = audio.GetService().map_err(|e| format!("reading the device: {e}"))?;
                return Ok(Self {
                    audio,
                    capture,
                    converter: Converter::new(Format::MIXER),
                    ready: None,
                });
            }
            // Windows would not convert: take the device's own format.
            let audio: IAudioClient = endpoint.Activate(CLSCTX_ALL, None).map_err(|e| format!("opening the device: {e}"))?;
            let mix = audio.GetMixFormat().map_err(|e| format!("the device's format: {e}"))?;
            let format = format_of(mix);
            let init = audio.Initialize(AUDCLNT_SHAREMODE_SHARED, base, BUFFER_HNS, 0, mix, None);
            CoTaskMemFree(Some(mix.cast()));
            init.map_err(|e| format!("starting the device: {e}"))?;
            let format = format.ok_or("the device's sound format is not one Hippius reads")?;
            let capture: IAudioCaptureClient = audio.GetService().map_err(|e| format!("reading the device: {e}"))?;
            Ok(Self {
                audio,
                capture,
                converter: Converter::new(format),
                ready: None,
            })
        }
    }

    /// Everything played except process `pid`'s tree (Windows 11). A
    /// process-loopback client has no mix format of its own, so it is asked
    /// for the mixer's float format, then for plain 16-bit PCM; it runs in
    /// event mode, as Windows' own sample does.
    fn open_process_loopback(pid: u32) -> Result<Self, String> {
        let attempts = [
            Format::MIXER,
            Format {
                sample: SampleFormat::I16,
                channels: 2,
                rate: SAMPLE_RATE,
            },
        ];
        let mut last = String::new();
        for format in attempts {
            // A client that refused Initialize cannot be asked again: each
            // attempt activates a fresh one.
            let audio = activate_process_loopback(pid)?;
            let wanted = wave_format(format);
            // SAFETY: Initialize, CreateEventW, SetEventHandle and GetService
            // on the client activated above, on this thread; `wanted` lives
            // across the call.
            unsafe {
                let init = audio.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    BUFFER_HNS,
                    0,
                    (&raw const wanted).cast::<WAVEFORMATEX>(),
                    None,
                );
                if let Err(e) = init {
                    last = format!("starting process loopback: {e}");
                    continue;
                }
                let event = Event(CreateEventW(None, false, false, None).map_err(|e| format!("an event for process loopback: {e}"))?);
                audio.SetEventHandle(event.0).map_err(|e| format!("process loopback events: {e}"))?;
                let capture: IAudioCaptureClient = audio.GetService().map_err(|e| format!("reading process loopback: {e}"))?;
                return Ok(Self {
                    audio,
                    capture,
                    converter: Converter::new(format),
                    ready: Some(event),
                });
            }
        }
        Err(last)
    }

    /// Read packets until `stop`, handing each to `on_packet` with its time
    /// on the capture clock. `on_packet` returning false ends the read (the
    /// writer is gone). An `Err` is the device going away.
    fn read(mut self, stop: &AtomicBool, mut on_packet: impl FnMut(u64, Vec<f32>) -> bool) -> Result<(), String> {
        // SAFETY: Start/Stop on the client this thread opened.
        unsafe { self.audio.Start() }.map_err(|e| format!("starting: {e}"))?;
        let format = self.converter.format();
        let frame_bytes = format.frame_bytes();
        let result = (|| {
            while !stop.load(Ordering::SeqCst) {
                match &self.ready {
                    // SAFETY: a live event handle owned by this client.
                    Some(event) => {
                        let waited = unsafe { WaitForSingleObject(event.0, u32::try_from(POLL.as_millis() * 2).unwrap_or(20)) };
                        if waited != WAIT_OBJECT_0 {
                            continue;
                        }
                    }
                    None => std::thread::sleep(POLL),
                }
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
                    let time = sources::packet_time_us(qpc, com::qpc_micros(), frames, format.rate);
                    if samples.is_empty() {
                        continue;
                    }
                    if !on_packet(time, samples) {
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

/// Which endpoint to open.
enum EndpointChoice<'a> {
    Capture(&'a str),
    DefaultInput,
    DefaultOutput,
}

fn device_endpoint(id: Option<&str>) -> EndpointChoice<'_> {
    match id.filter(|id| !id.is_empty()) {
        Some(id) => EndpointChoice::Capture(id),
        None => EndpointChoice::DefaultInput,
    }
}

fn endpoint(choice: EndpointChoice<'_>) -> Result<IMMDevice, String> {
    // SAFETY: COM calls on objects created here, inside this thread's
    // apartment; the id string outlives the call.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("the audio devices: {e}"))?;
        match choice {
            EndpointChoice::Capture(id) => {
                let id = HSTRING::from(id);
                enumerator
                    .GetDevice(PCWSTR(id.as_ptr()))
                    .map_err(|e| format!("that microphone is not connected: {e}"))
            }
            EndpointChoice::DefaultInput => enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .map_err(|e| format!("no microphone: {e}")),
            EndpointChoice::DefaultOutput => enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("no speakers or headphones: {e}")),
        }
    }
}

/// The completion handler `ActivateAudioInterfaceAsync` calls. In its own
/// module so the lints `#[implement]`'s generated code trips stay there.
#[allow(clippy::ref_as_ptr, clippy::inline_always)]
mod activation {
    use std::sync::mpsc;
    use std::sync::{Mutex, PoisonError};

    use windows::Win32::Media::Audio::{
        IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    };
    use windows::Win32::System::Com::{IAgileObject, IAgileObject_Impl};
    use windows::core::{Ref, implement};

    /// Tells `activate_process_loopback` that Windows has an answer. Agile,
    /// as `ActivateAudioInterfaceAsync` requires of its handler (it is called
    /// on a worker thread).
    #[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
    pub(super) struct Activated(pub(super) Mutex<Option<mpsc::Sender<()>>>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            if let Some(done) = self.0.lock().unwrap_or_else(PoisonError::into_inner).take() {
                let _ = done.send(());
            }
            Ok(())
        }
    }

    impl IAgileObject_Impl for Activated_Impl {}
}

use activation::Activated;

/// An audio client for process loopback leaving out `pid`'s tree, from
/// Windows' virtual process-loopback device.
fn activate_process_loopback(pid: u32) -> Result<IAudioClient, String> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let mut prop = PROPVARIANT::default();
    // SAFETY: a zeroed PROPVARIANT filled in as a VT_BLOB pointing at
    // `params`, which outlives the call below. The PROPVARIANT is never
    // cleared (no PropVariantClear), so the blob is not freed as if
    // CoTaskMemAlloc'd.
    unsafe {
        let inner = &mut *prop.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: u32::try_from(std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>()).unwrap_or(0),
            pBlobData: (&raw const params).cast_mut().cast(),
        };
    }
    let (done_tx, done_rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(done_tx))).into();
    // SAFETY: the device path is Windows' own constant; `prop` and
    // `params` live until the activation has answered (or timed out, after
    // which the operation is dropped and never reads them again: the call
    // copies the blob before it returns).
    let operation = unsafe {
        ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&raw const prop), &handler)
            .map_err(|e| format!("asking for process loopback: {e}"))?
    };
    done_rx
        .recv_timeout(ACTIVATE_WITHIN)
        .map_err(|_| "Windows did not answer the process loopback request".to_string())?;
    let mut result = HRESULT(0);
    let mut activated: Option<IUnknown> = None;
    // SAFETY: both out-pointers are live locals; the operation has completed.
    unsafe { operation.GetActivateResult(&raw mut result, &raw mut activated) }.map_err(|e| format!("process loopback: {e}"))?;
    result.ok().map_err(|e| format!("process loopback was refused: {e}"))?;
    activated
        .ok_or_else(|| "process loopback gave no client".to_string())?
        .cast::<IAudioClient>()
        .map_err(|e| format!("process loopback: {e}"))
}

/// `format` as `WAVEFORMATEXTENSIBLE`.
fn wave_format(format: Format) -> WAVEFORMATEXTENSIBLE {
    let bits = u16::try_from(format.sample.bytes() * 8).unwrap_or(32);
    let block = u16::try_from(format.frame_bytes()).unwrap_or(8);
    let mut wave = WAVEFORMATEXTENSIBLE::default();
    wave.Format.wFormatTag = pcm::WAVE_FORMAT_EXTENSIBLE;
    wave.Format.nChannels = format.channels;
    wave.Format.nSamplesPerSec = format.rate;
    wave.Format.nAvgBytesPerSec = format.rate * u32::from(block);
    wave.Format.nBlockAlign = block;
    wave.Format.wBitsPerSample = bits;
    wave.Format.cbSize = 22;
    wave.Samples.wValidBitsPerSample = bits;
    wave.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    wave.SubFormat = if format.sample == SampleFormat::F32 {
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    } else {
        windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM
    };
    wave
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
    /// the converter is a copy; the 16-bit fallback reads back as itself.
    #[test]
    fn the_formats_asked_for_read_back_as_themselves() {
        for format in [
            Format::MIXER,
            Format {
                sample: SampleFormat::I16,
                channels: 2,
                rate: SAMPLE_RATE,
            },
        ] {
            let wave = wave_format(format);
            // SAFETY: a fully initialised local, read as its base struct.
            let got = unsafe { format_of((&raw const wave).cast()) };
            assert_eq!(got, Some(format));
        }
    }
}
