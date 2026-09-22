//! Crash breadcrumbs. A native crash (illegal instruction, segfault, a C/C++
//! abort) kills the process before the UI can say anything, so the bug report
//! would otherwise never see it - the AVX-512 build that crashed on first
//! transcription (6x1i) was diagnosed from photos of Event Viewer.
//!
//! `install` hooks the process-wide last-chance handlers (Windows unhandled
//! exception filter + CRT SIGABRT; unix fault signals) to write a small
//! `key=value` record to `last-crash.txt` in the app data dir, then hands the
//! crash on unchanged (WER / the previous handler still see it). The next
//! launch reads it back for `/app/v1/system-info` (`last_crash`).
//!
//! The handlers run on a crashed thread (a signal handler, on unix), so they
//! must not allocate or lock: everything they read is prepared at install time
//! and the record is formatted into a stack buffer.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

const FILE: &str = "last-crash.txt";

/// Native work a crash is most likely to land in, recorded as `during=`.
#[derive(Clone, Copy)]
pub enum Phase {
    Whisper,
    WhisperLoad,
    Piper,
}

const PHASE_NAMES: [&str; 3] = ["whisper", "whisper-load", "piper"];
// Counts, not a single current phase: STT and TTS can run at once.
static ACTIVE: [AtomicU32; 3] = [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];

/// Marks `phase` active until the guard drops.
pub struct Busy(Phase);

pub fn busy(phase: Phase) -> Busy {
    ACTIVE[phase as usize].fetch_add(1, Ordering::SeqCst);
    Busy(phase)
}

impl Drop for Busy {
    fn drop(&mut self) {
        ACTIVE[self.0 as usize].fetch_sub(1, Ordering::SeqCst);
    }
}

static VERSION: OnceLock<String> = OnceLock::new();
static LAST: OnceLock<Option<Value>> = OnceLock::new();
static WROTE: AtomicBool = AtomicBool::new(false);

/// Read the previous run's record (kept until the next crash replaces it) and
/// arm the handlers. Call once, early.
pub fn install(data_dir: &Path, version: &str) {
    let path = data_dir.join(FILE);
    let _ = LAST.set(std::fs::read_to_string(&path).ok().and_then(|s| parse(&s)));
    let _ = VERSION.set(version.to_string());
    if std::fs::create_dir_all(data_dir).is_err() {
        return;
    }
    imp::install(&path);
}

/// The most recent recorded crash, from any earlier run.
pub fn last_crash() -> Option<Value> {
    LAST.get().cloned().flatten()
}

fn parse(text: &str) -> Option<Value> {
    let mut map = Map::new();
    for (k, v) in text.lines().filter_map(|l| l.split_once('=')) {
        let value = match k {
            "time" => v.parse::<u64>().map(Value::from).unwrap_or(Value::Null),
            "during" => Value::from(v.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>()),
            _ => Value::from(v),
        };
        map.insert(k.to_string(), value);
    }
    map.contains_key("kind").then(|| json!(map))
}

/// Fixed-size, allocation-free `fmt::Write` target; overlong output truncates.
struct Buf {
    bytes: [u8; 1024],
    len: usize,
}

impl std::fmt::Write for Buf {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let n = s.len().min(self.bytes.len() - self.len);
        self.bytes[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
        self.len += n;
        Ok(())
    }
}

/// Where the fault happened: `module+0xoffset` when the address resolves to a
/// loaded image (the form Event Viewer prints), else the raw address.
struct Loc<'a> {
    module: Option<&'a [u8]>,
    offset: usize,
}

/// Format the record and hand it to the platform writer. First crash wins, so
/// a fault inside the handler (or two threads faulting at once) can't loop.
fn record(kind: &str, loc: Option<Loc>, write: impl FnOnce(&[u8])) {
    if WROTE.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut buf = Buf { bytes: [0; 1024], len: 0 };
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let _ = write!(
        buf,
        "version={}\ntime={time}\nkind={kind}\n",
        VERSION.get().map_or("?", |v| v.as_str())
    );
    if let Some(loc) = loc {
        let _ = buf.write_str("at=");
        if let Some(module) = loc.module {
            // Basename only: the full path carries the user's account name.
            let base = module
                .rsplit(|&b| b == b'/' || b == b'\\')
                .next()
                .unwrap_or(module);
            let _ = buf.write_str(std::str::from_utf8(base).unwrap_or("?"));
            let _ = buf.write_str("+");
        }
        let _ = write!(buf, "{:#x}\n", loc.offset);
    }
    let _ = buf.write_str("during=");
    let mut first = true;
    for (i, name) in PHASE_NAMES.iter().enumerate() {
        if ACTIVE[i].load(Ordering::SeqCst) > 0 {
            if !first {
                let _ = buf.write_str(",");
            }
            let _ = buf.write_str(name);
            first = false;
        }
    }
    let _ = buf.write_str("\n");
    write(&buf.bytes[..buf.len]);
}

#[cfg(unix)]
mod imp {
    use std::cell::UnsafeCell;
    use std::ffi::{c_int, c_void, CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::OnceLock;

    use super::{record, Loc};

    const SIGNALS: [(c_int, &str); 5] = [
        (libc::SIGILL, "SIGILL (illegal instruction)"),
        (libc::SIGSEGV, "SIGSEGV (segfault)"),
        (libc::SIGBUS, "SIGBUS (bus error)"),
        (libc::SIGFPE, "SIGFPE (arithmetic fault)"),
        (libc::SIGABRT, "SIGABRT (abort)"),
    ];

    static PATH: OnceLock<CString> = OnceLock::new();

    // The handlers we replaced (Rust's stack-overflow guard, for SEGV/BUS),
    // restored before handing the crash on. Written only in install, before
    // any of our handlers can run.
    struct Previous(UnsafeCell<[libc::sigaction; 5]>);
    unsafe impl Sync for Previous {}
    static PREVIOUS: Previous = Previous(UnsafeCell::new(unsafe { std::mem::zeroed() }));

    pub fn install(path: &Path) {
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return };
        let _ = PATH.set(c);
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction =
                on_signal as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as usize;
            action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
            libc::sigemptyset(&mut action.sa_mask);
            let previous = &mut *PREVIOUS.0.get();
            for (i, (sig, _)) in SIGNALS.iter().enumerate() {
                libc::sigaction(*sig, &action, &mut previous[i]);
            }
        }
    }

    extern "C" fn on_signal(sig: c_int, info: *mut libc::siginfo_t, ctx: *mut c_void) {
        let Some(i) = SIGNALS.iter().position(|(s, _)| *s == sig) else { return };
        let loc = unsafe { pc(info, ctx) }.map(locate);
        record(SIGNALS[i].1, loc, |bytes| unsafe {
            let Some(path) = PATH.get() else { return };
            let fd = libc::open(
                path.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_CLOEXEC,
                0o644,
            );
            if fd >= 0 {
                libc::write(fd, bytes.as_ptr().cast(), bytes.len());
                libc::close(fd);
            }
        });
        unsafe {
            libc::sigaction(sig, &(*PREVIOUS.0.get())[i], std::ptr::null_mut());
            // A fault re-executes the faulting instruction on return and lands
            // in the restored handler; abort() was a one-off raise, so repeat it.
            if sig == libc::SIGABRT {
                libc::raise(sig);
            }
        }
    }

    /// The faulting instruction. si_addr is the pc for SIGILL/SIGFPE but the
    /// bad data address for SEGV/BUS, so prefer the saved register state.
    #[allow(unused_variables)]
    unsafe fn pc(info: *mut libc::siginfo_t, ctx: *mut c_void) -> Option<usize> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let uc = ctx as *const libc::ucontext_t;
            if !uc.is_null() && !(*uc).uc_mcontext.is_null() {
                return Some((*(*uc).uc_mcontext).__ss.__pc as usize);
            }
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            let uc = ctx as *const libc::ucontext_t;
            if !uc.is_null() {
                return Some((*uc).uc_mcontext.gregs[libc::REG_RIP as usize] as usize);
            }
        }
        None
    }

    fn locate(addr: usize) -> Loc<'static> {
        unsafe {
            let mut dl: libc::Dl_info = std::mem::zeroed();
            if libc::dladdr(addr as *const c_void, &mut dl) != 0 && !dl.dli_fname.is_null() {
                return Loc {
                    module: Some(CStr::from_ptr(dl.dli_fname).to_bytes()),
                    offset: addr - dl.dli_fbase as usize,
                };
            }
        }
        Loc { module: None, offset: addr }
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_int;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HMODULE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetUnhandledExceptionFilter, EXCEPTION_POINTERS, LPTOP_LEVEL_EXCEPTION_FILTER,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameA, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };

    use super::{record, Loc};

    static PATH: OnceLock<Vec<u16>> = OnceLock::new();
    static PREVIOUS: OnceLock<LPTOP_LEVEL_EXCEPTION_FILTER> = OnceLock::new();
    // Module-name scratch for the (single, WROTE-guarded) record.
    static mut MODULE: [u8; 260] = [0; 260];

    pub fn install(path: &Path) {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let _ = PATH.set(wide);
        unsafe {
            let previous = SetUnhandledExceptionFilter(Some(on_exception));
            let _ = PREVIOUS.set(previous);
            // MSVC abort() (ggml's GGML_ABORT, C++ terminate) raises SIGABRT
            // through the CRT before failing fast, bypassing the filter above.
            libc::signal(libc::SIGABRT, on_abort as extern "C" fn(c_int) as usize);
        }
    }

    unsafe extern "system" fn on_exception(info: *const EXCEPTION_POINTERS) -> i32 {
        let rec = if info.is_null() { std::ptr::null_mut() } else { (*info).ExceptionRecord };
        if !rec.is_null() {
            let code = (*rec).ExceptionCode as u32;
            let mut kind = super::Buf { bytes: [0; 1024], len: 0 };
            let _ = std::fmt::Write::write_fmt(&mut kind, format_args!("{} ({code:#010x})", name(code)));
            let kind = std::str::from_utf8(&kind.bytes[..kind.len]).unwrap_or("exception");
            record(kind, Some(locate((*rec).ExceptionAddress as usize)), write);
        }
        match PREVIOUS.get().copied().flatten() {
            Some(previous) => previous(info),
            None => 0, // EXCEPTION_CONTINUE_SEARCH: WER still records it
        }
    }

    extern "C" fn on_abort(_: c_int) {
        record("abort()", None, write);
    }

    fn name(code: u32) -> &'static str {
        match code {
            0xc000001d => "illegal instruction",
            0xc0000005 => "access violation",
            0xc00000fd => "stack overflow",
            0xc0000094 => "integer divide by zero",
            0xc0000409 => "stack buffer overrun",
            _ => "exception",
        }
    }

    fn locate(addr: usize) -> Loc<'static> {
        unsafe {
            let mut module: HMODULE = std::ptr::null_mut();
            if GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                addr as *const u16,
                &mut module,
            ) != 0
            {
                let buf = &mut *std::ptr::addr_of_mut!(MODULE);
                let n = GetModuleFileNameA(module, buf.as_mut_ptr(), buf.len() as u32) as usize;
                return Loc {
                    module: (n > 0).then(|| &buf[..n.min(buf.len())]),
                    offset: addr - module as usize,
                };
            }
        }
        Loc { module: None, offset: addr }
    }

    fn write(bytes: &[u8]) {
        let Some(path) = PATH.get() else { return };
        unsafe {
            let h = CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
                0,
                std::ptr::null(),
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            );
            if h != INVALID_HANDLE_VALUE {
                let mut written = 0u32;
                WriteFile(h, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut());
                CloseHandle(h);
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    pub fn install(_: &std::path::Path) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_record() {
        let v = parse(
            "version=2.10.1\ntime=1790000000\nkind=illegal instruction (0xc000001d)\nat=app.exe+0x1756e76\nduring=whisper,piper\n",
        )
        .unwrap();
        assert_eq!(v["version"], "2.10.1");
        assert_eq!(v["time"], 1790000000u64);
        assert_eq!(v["at"], "app.exe+0x1756e76");
        assert_eq!(v["during"], json!(["whisper", "piper"]));
    }

    #[test]
    fn rejects_junk() {
        assert!(parse("").is_none());
        assert!(parse("hello").is_none());
    }
}
