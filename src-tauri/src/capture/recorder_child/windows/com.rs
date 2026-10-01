//! The per-thread Windows setup the recorder needs, each undone on drop:
//! COM (multithreaded apartment), Media Foundation, and the request that
//! keeps the display and the system awake while a recording runs. Plus the
//! capture clock: QueryPerformanceCounter in microseconds, the clock WGC
//! frames (`SystemRelativeTime`) and WASAPI packets (`u64QPCPosition`) are
//! stamped on, so pause, video and audio compare like with like.

use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_FULL, MFShutdown, MFStartup};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState};

/// Now on the capture clock, in microseconds.
pub fn qpc_micros() -> u64 {
    let mut count = 0i64;
    let mut frequency = 0i64;
    // SAFETY: both out-pointers are valid locals; the calls cannot fail on
    // Windows XP and later.
    unsafe {
        let _ = QueryPerformanceCounter(&raw mut count);
        let _ = QueryPerformanceFrequency(&raw mut frequency);
    }
    qpc_to_micros(count, frequency)
}

/// A QPC count at `frequency` ticks per second, in microseconds, without
/// overflowing on a machine that has been up for months.
pub fn qpc_to_micros(count: i64, frequency: i64) -> u64 {
    if count <= 0 || frequency <= 0 {
        return 0;
    }
    let micros = i128::from(count) * 1_000_000 / i128::from(frequency);
    u64::try_from(micros).unwrap_or(u64::MAX)
}

/// A 100 ns timestamp on the QPC clock (WGC's `SystemRelativeTime`,
/// WASAPI's QPC position) in microseconds.
pub fn hns_to_micros(hns: i64) -> u64 {
    u64::try_from(hns / 10).unwrap_or(0)
}

/// COM on this thread, multithreaded; left on drop if this call entered it.
/// Not `Send`: it must be dropped on the thread that entered.
pub struct Apartment(bool, std::marker::PhantomData<*const ()>);

impl Apartment {
    pub fn enter() -> Self {
        // SAFETY: no reserved pointer; paired with CoUninitialize on drop
        // only when it succeeded (S_OK or S_FALSE).
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self(hr.is_ok(), std::marker::PhantomData)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx above, on the
            // same thread (the guard is not Send).
            unsafe { CoUninitialize() };
        }
    }
}

/// Media Foundation started for this process; shut down on drop.
pub struct MediaFoundation(bool);

impl MediaFoundation {
    pub fn start() -> Self {
        // SAFETY: plain call; balanced by MFShutdown on drop when it worked.
        Self(unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.is_ok())
    }
}

impl Drop for MediaFoundation {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful MFStartup above.
            let _ = unsafe { MFShutdown() };
        }
    }
}

/// Keeps the display on and the system awake while this thread lives (the
/// state is per thread and cleared when it is reset or the thread ends).
pub struct KeepAwake;

impl KeepAwake {
    pub fn start() -> Self {
        // SAFETY: plain call with documented flag values.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED) };
        Self
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        // SAFETY: plain call; ES_CONTINUOUS alone clears this thread's request.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qpc_counts_become_microseconds_without_overflow() {
        assert_eq!(qpc_to_micros(10_000_000, 10_000_000), 1_000_000);
        assert_eq!(qpc_to_micros(3_000, 3_000_000), 1_000);
        // Up for a year at 10 MHz.
        let year = 10_000_000i64 * 3600 * 24 * 365;
        assert_eq!(qpc_to_micros(year, 10_000_000), 3_600_000_000 * 24 * 365);
        assert_eq!(qpc_to_micros(-5, 10), 0);
        assert_eq!(hns_to_micros(12_345_670), 1_234_567);
    }

    #[test]
    fn the_clock_moves_forward() {
        let a = qpc_micros();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(qpc_micros() > a);
    }
}
