//! The crate's only `unsafe` code: small Win32 FFI shims, Windows only.
//!
//! `Cargo.toml` denies `unsafe_code` everywhere; `lib.rs` allows it for this
//! module alone. Every `unsafe` block carries a `// SAFETY:` comment stating
//! why the pointers and handles it passes are valid.

/// Working-set size of this process in bytes (`K32GetProcessMemoryInfo`).
/// Used by the headless smoke benchmarks to report resident memory.
pub fn process_working_set_bytes() -> Option<u64> {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCounters {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            ppsmem_counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    let mut counters = std::mem::MaybeUninit::<ProcessMemoryCounters>::zeroed();
    let cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    // SAFETY: `counters` is zero-initialised storage of exactly `cb` bytes, `cb`
    // is set before the call as the API requires, and `assume_init` only runs
    // after the call reports success (every field is plain integer data).
    unsafe {
        (*counters.as_mut_ptr()).cb = cb;
        let ok = K32GetProcessMemoryInfo(GetCurrentProcess(), counters.as_mut_ptr(), cb);
        if ok != 0 {
            Some(counters.assume_init().WorkingSetSize as u64)
        } else {
            None
        }
    }
}

/// Whether Windows "Show animations in Windows" is on
/// (`SPI_GETCLIENTAREAANIMATION`). Defaults to on if the query fails.
#[cfg(feature = "gui")]
pub(crate) fn client_area_animations_enabled() -> bool {
    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(
            uiAction: u32,
            uiParam: u32,
            pvParam: *mut std::ffi::c_void,
            fWinIni: u32,
        ) -> i32;
    }
    let mut enabled: i32 = 1;
    // SAFETY: `enabled` is a valid stack i32 aligned pointer expecting BOOL output.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    if ok == 0 { true } else { enabled != 0 }
}

/// Paint the native caption to match the app theme (dark mode, caption, text
/// and border colours) on the visible top-level window.
#[cfg(feature = "gui")]
pub(crate) fn sync_titlebar(window: &gpui::Window, is_dark: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    const GA_ROOT: u32 = 2;
    const DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1: u32 = 19;
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const RDW_INVALIDATE: u32 = 0x0001;
    const RDW_UPDATENOW: u32 = 0x0100;
    const RDW_FRAME: u32 = 0x0400;

    const fn win32_colorref(r: u8, g: u8, b: u8) -> u32 {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            dwAttribute: u32,
            pvAttribute: *const std::ffi::c_void,
            cbAttribute: u32,
        ) -> i32;
        fn DwmGetWindowAttribute(
            hwnd: isize,
            dwAttribute: u32,
            pvAttribute: *mut std::ffi::c_void,
            cbAttribute: u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAncestor(hwnd: isize, gaFlags: u32) -> isize;
        fn SetWindowPos(
            hwnd: isize,
            hwndInsertAfter: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> i32;
        fn RedrawWindow(
            hwnd: isize,
            lprcUpdate: *const std::ffi::c_void,
            hrgnUpdate: isize,
            flags: u32,
        ) -> i32;
        fn EnumWindows(
            callback: unsafe extern "system" fn(isize, isize) -> i32,
            lparam: isize,
        ) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn GetClassNameW(hwnd: isize, buffer: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
    }

    struct VisibleWindowSearch {
        pid: u32,
        found: isize,
    }

    // GPUI's `HasWindowHandle` returns its hidden `Zed::PlatformWindow`, which owns
    // the DWM state, but Windows paints the caption of the visible `Zed::Window`.
    // Walk the process' top-level windows and pick the visible one.
    unsafe extern "system" fn find_visible_window(hwnd: isize, lparam: isize) -> i32 {
        // SAFETY: `lparam` is the `&mut VisibleWindowSearch` passed to `EnumWindows`
        // below; it outlives the synchronous enumeration and nothing else aliases it.
        let search = unsafe { &mut *(lparam as *mut VisibleWindowSearch) };
        let mut pid = 0u32;
        // SAFETY: `hwnd` is supplied by `EnumWindows`; `pid` is a valid out pointer.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        // SAFETY: `hwnd` is a live top-level window handle from `EnumWindows`.
        if pid != search.pid || unsafe { IsWindowVisible(hwnd) } == 0 {
            return 1;
        }
        let mut buffer = [0u16; 64];
        // SAFETY: `buffer` is a writable u16 array and its length is passed as `max`.
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len > 0 && String::from_utf16_lossy(&buffer[..len as usize]) == "Zed::Window" {
            search.found = hwnd;
            return 0;
        }
        1
    }

    let Ok(wh) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(handle) = wh.as_raw() else {
        return;
    };
    let raw_hwnd = handle.hwnd.get();
    // SAFETY: `raw_hwnd` comes from GPUI's live Win32 window handle; resolve the
    // visible top-level HWND that actually paints the caption.
    let target_hwnd = unsafe {
        let root = GetAncestor(raw_hwnd, GA_ROOT);
        let candidate = if root != 0 { root } else { raw_hwnd };
        if IsWindowVisible(candidate) != 0 {
            candidate
        } else {
            let mut search = VisibleWindowSearch {
                pid: std::process::id(),
                found: 0,
            };
            EnumWindows(find_visible_window, &mut search as *mut _ as isize);
            if search.found != 0 {
                search.found
            } else {
                candidate
            }
        }
    };

    let dark_mode: i32 = if is_dark { 1 } else { 0 };
    let caption_color: u32 = if is_dark {
        win32_colorref(0x15, 0x18, 0x1D)
    } else {
        win32_colorref(0xFF, 0xFF, 0xFF)
    };
    let text_color: u32 = if is_dark {
        win32_colorref(0xE7, 0xE9, 0xEC)
    } else {
        win32_colorref(0x1B, 0x1D, 0x21)
    };
    let border_color: u32 = if is_dark {
        win32_colorref(0x25, 0x2B, 0x35)
    } else {
        win32_colorref(0xE2, 0xDD, 0xD5)
    };

    // SAFETY: Each attribute points to a 4-byte scalar with matching `cbAttribute == 4`.
    unsafe {
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&dark_mode as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1,
            (&dark_mode as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_CAPTION_COLOR,
            (&caption_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_TEXT_COLOR,
            (&text_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_BORDER_COLOR,
            (&border_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );

        let mut verified_dark: i32 = -1;
        let hr = DwmGetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&mut verified_dark as *mut i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        if hr != 0 || verified_dark != dark_mode {
            tracing::debug!(
                target_hwnd,
                expected = dark_mode,
                observed = verified_dark,
                hr,
                "DWM titlebar dark-mode attribute readback mismatch"
            );
            if target_hwnd != raw_hwnd {
                let _ = DwmSetWindowAttribute(
                    raw_hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    (&dark_mode as *const i32).cast(),
                    std::mem::size_of::<i32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    raw_hwnd,
                    DWMWA_CAPTION_COLOR,
                    (&caption_color as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }

        let _ = SetWindowPos(
            target_hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        let _ = RedrawWindow(
            target_hwnd,
            std::ptr::null(),
            0,
            RDW_FRAME | RDW_INVALIDATE | RDW_UPDATENOW,
        );
    }
}
