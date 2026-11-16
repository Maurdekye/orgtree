//! Window probes for the native desktop checks and captures, ports of the
//! ctypes snippets they used before 4.6.1:
//!
//!   nc-hittest HWND POINTS   WM_NCHITTEST (SendMessageTimeoutW, 2 s) at each
//!                            screen point; POINTS is the JSON the callers had
//!                            ([{"x":..,"y":..},...]); prints a JSON array
//!                            (was the inline hit.py)
//!   shell-properties HWND    the window's AppUserModel property store, keys
//!                            2..5 of PKEY_AppUserModel (ID, RelaunchCommand,
//!                            RelaunchIconResource, RelaunchDisplayNameResource);
//!                            prints {"2": "text" | {"hr":..,"type":..}, ...}
//!                            (was tests/native-shell-properties.py)
//!   owned-dialog PID OWNER BMP  waits up to 2.5 s for a #32770 dialog of PID,
//!                            captures it with PrintWindow into BMP, closes it
//!                            with WM_CLOSE and prints what it saw (was the
//!                            inline hwnd_probe.py of nativepicker.capture.cjs)
//!
//! Raw extern declarations, exactly the calls the Python made, so no COM or
//! GDI wrappers are pulled in.

use std::ffi::c_void;
use std::time::{Duration, Instant};

type Hwnd = isize;
type Bool = i32;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pels: i32,
    y_pels: i32,
    clr_used: u32,
    clr_important: u32,
}

#[repr(C)]
struct Guid([u8; 16]);

#[repr(C)]
struct PropertyKey {
    fmtid: Guid,
    pid: u32,
}

#[repr(C)]
struct PropVariant {
    vt: u16,
    pad: [u16; 3],
    value: *mut c_void,
    extra: *mut c_void,
}

#[link(name = "user32")]
extern "system" {
    fn SendMessageTimeoutW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize, flags: u32, timeout: u32, result: *mut usize) -> isize;
    fn EnumWindows(callback: extern "system" fn(Hwnd, isize) -> Bool, lparam: isize) -> Bool;
    fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    fn GetClassNameW(hwnd: Hwnd, buffer: *mut u16, max: i32) -> i32;
    fn GetWindowTextW(hwnd: Hwnd, buffer: *mut u16, max: i32) -> i32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> Bool;
    fn GetWindow(hwnd: Hwnd, cmd: u32) -> Hwnd;
    fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
    fn GetWindowDC(hwnd: Hwnd) -> isize;
    fn ReleaseDC(hwnd: Hwnd, hdc: isize) -> i32;
    fn PrintWindow(hwnd: Hwnd, hdc: isize, flags: u32) -> Bool;
    fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> Bool;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn CreateCompatibleBitmap(hdc: isize, w: i32, h: i32) -> isize;
    fn SelectObject(hdc: isize, object: isize) -> isize;
    fn DeleteObject(object: isize) -> Bool;
    fn DeleteDC(hdc: isize) -> Bool;
    fn GetDIBits(hdc: isize, bitmap: isize, start: u32, lines: u32, bits: *mut c_void, info: *mut BitmapInfoHeader, usage: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetPropertyStoreForWindow(hwnd: Hwnd, riid: *const Guid, store: *mut *mut c_void) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitialize(reserved: *const c_void) -> i32;
    fn PropVariantClear(value: *mut PropVariant) -> i32;
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" in the in-memory (bytes_le) order.
fn guid(text: &str) -> Guid {
    let hex: Vec<u8> = text.split('-').collect::<String>().as_bytes().chunks(2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect();
    let mut b = [0u8; 16];
    b[0..4].copy_from_slice(&[hex[3], hex[2], hex[1], hex[0]]);
    b[4..6].copy_from_slice(&[hex[5], hex[4]]);
    b[6..8].copy_from_slice(&[hex[7], hex[6]]);
    b[8..16].copy_from_slice(&hex[8..16]);
    Guid(b)
}

fn numbers_after(text: &str, key: &str) -> Vec<i64> {
    let needle = format!("\"{key}\"");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(&needle) {
        rest = &rest[at + needle.len()..];
        let value = rest.trim_start().strip_prefix(':').unwrap_or("").trim_start();
        let end = value.find(|c: char| !(c == '-' || c == '.' || c.is_ascii_digit())).unwrap_or(value.len());
        out.push(value[..end].parse::<f64>().map(|v| v as i64).unwrap_or(0));
    }
    out
}

pub fn nc_hittest(args: &[String]) -> i32 {
    let (Some(hwnd), Some(points)) = (args.first().and_then(|h| h.parse::<isize>().ok()), args.get(1)) else { return 2 };
    let (xs, ys) = (numbers_after(points, "x"), numbers_after(points, "y"));
    if xs.len() != ys.len() {
        eprintln!("points need an x and a y each");
        return 2;
    }
    let mut answer = Vec::new();
    for (x, y) in xs.iter().zip(ys.iter()) {
        let packed = ((*x as isize) & 0xFFFF) | (((*y as isize) & 0xFFFF) << 16);
        let mut result = 0usize;
        // SAFETY: plain Win32 call; result is a local.
        let ok = unsafe { SendMessageTimeoutW(hwnd, 0x84, 0, packed, 2, 2000, &mut result) };
        if ok == 0 {
            eprintln!("SendMessageTimeoutW failed: {}", std::io::Error::last_os_error());
            return 1;
        }
        answer.push(result.to_string());
    }
    println!("[{}]", answer.join(", "));
    0
}

pub fn shell_properties(args: &[String]) -> i32 {
    let Some(hwnd) = args.first().and_then(|h| h.parse::<isize>().ok()) else { return 2 };
    let iid_store = guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    let fmtid = "9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3";
    let mut out = Vec::new();
    // SAFETY: raw COM through the IPropertyStore vtable, as the Python did:
    // slot 2 Release, slot 5 GetValue.
    unsafe {
        CoInitialize(std::ptr::null());
        let mut store: *mut c_void = std::ptr::null_mut();
        let hr = SHGetPropertyStoreForWindow(hwnd, &iid_store, &mut store);
        if hr != 0 || store.is_null() {
            eprintln!("SHGetPropertyStoreForWindow failed: 0x{:08x}", hr as u32);
            return 1;
        }
        let vtable = *(store as *const *const usize);
        type GetValue = extern "system" fn(*mut c_void, *const PropertyKey, *mut PropVariant) -> i32;
        type Release = extern "system" fn(*mut c_void) -> u32;
        let get: GetValue = std::mem::transmute(*vtable.add(5));
        let release: Release = std::mem::transmute(*vtable.add(2));
        for pid in [2u32, 3, 4, 5] {
            let key = PropertyKey { fmtid: guid(fmtid), pid };
            let mut value = PropVariant { vt: 0, pad: [0; 3], value: std::ptr::null_mut(), extra: std::ptr::null_mut() };
            let hr = get(store, &key, &mut value);
            let text = if hr == 0 && value.vt == 31 && !value.value.is_null() {
                let p = value.value as *const u16;
                let mut n = 0;
                while *p.add(n) != 0 {
                    n += 1;
                }
                json_string(&String::from_utf16_lossy(std::slice::from_raw_parts(p, n)))
            } else {
                format!("{{\"hr\": {}, \"type\": {}}}", hr, value.vt)
            };
            out.push(format!("\"{pid}\": {text}"));
            PropVariantClear(&mut value);
        }
        release(store);
    }
    println!("{{{}}}", out.join(", "));
    0
}

fn class_name(hwnd: Hwnd) -> String {
    let mut buffer = [0u16; 256];
    // SAFETY: the buffer outlives the call.
    let n = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), 256) };
    String::from_utf16_lossy(&buffer[..n.max(0) as usize])
}

fn window_text(hwnd: Hwnd) -> String {
    let mut buffer = [0u16; 512];
    // SAFETY: the buffer outlives the call.
    let n = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), 512) };
    String::from_utf16_lossy(&buffer[..n.max(0) as usize])
}

struct Search {
    pid: u32,
    owner: Hwnd,
    found: Option<Hwnd>,
}

extern "system" fn enum_callback(hwnd: Hwnd, lparam: isize) -> Bool {
    // SAFETY: lparam is the &mut Search passed to EnumWindows below.
    let search = unsafe { &mut *(lparam as *mut Search) };
    let mut pid = 0u32;
    // SAFETY: plain Win32 call.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid != search.pid || hwnd == search.owner {
        return 1;
    }
    if search.found.is_none() && class_name(hwnd) == "#32770" {
        search.found = Some(hwnd);
    }
    1
}

fn find_owned_dialog(pid: u32, owner: Hwnd) -> Option<Hwnd> {
    let mut search = Search { pid, owner, found: None };
    // SAFETY: the callback only touches `search`, which outlives the call.
    unsafe { EnumWindows(enum_callback, &mut search as *mut Search as isize) };
    search.found
}

fn capture_bmp(hwnd: Hwnd, file: &str) -> String {
    let mut rc = Rect::default();
    // SAFETY: GDI calls on handles created and released here.
    unsafe {
        if GetWindowRect(hwnd, &mut rc) == 0 {
            return "{\"captured\": false, \"reason\": \"GetWindowRect failed\"}".into();
        }
        let (w, h) = ((rc.right - rc.left).max(0), (rc.bottom - rc.top).max(0));
        if w <= 0 || h <= 0 {
            return format!("{{\"captured\": false, \"reason\": {}}}", json_string(&format!("empty rect {w}x{h}")));
        }
        let hdc_win = GetWindowDC(hwnd);
        let hdc_mem = CreateCompatibleDC(hdc_win);
        let bitmap = CreateCompatibleBitmap(hdc_win, w, h);
        let old = SelectObject(hdc_mem, bitmap);
        let mut printed = PrintWindow(hwnd, hdc_mem, 2) != 0;
        if !printed {
            printed = PrintWindow(hwnd, hdc_mem, 0) != 0;
        }
        let mut info = BitmapInfoHeader { size: std::mem::size_of::<BitmapInfoHeader>() as u32, width: w, height: -h, planes: 1, bit_count: 32, ..Default::default() };
        let length = (w * h * 4) as usize;
        let mut pixels = vec![0u8; length];
        let scan = GetDIBits(hdc_mem, bitmap, 0, h as u32, pixels.as_mut_ptr() as *mut c_void, &mut info, 0);
        SelectObject(hdc_mem, old);
        DeleteObject(bitmap);
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_win);
        let non_black = pixels.chunks(4).filter(|p| p[0] != 0 || p[1] != 0 || p[2] != 0).count();
        let total = (w * h).max(1) as f64;
        // Bottom-up 32 bpp BMP for nativeImage.
        let header = BitmapInfoHeader { size: std::mem::size_of::<BitmapInfoHeader>() as u32, width: w, height: h, planes: 1, bit_count: 32, size_image: length as u32, ..Default::default() };
        let offset = 14 + std::mem::size_of::<BitmapInfoHeader>() as u32;
        let mut bmp = Vec::with_capacity(offset as usize + length);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(offset + length as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]);
        bmp.extend_from_slice(&offset.to_le_bytes());
        bmp.extend_from_slice(std::slice::from_raw_parts(&header as *const _ as *const u8, std::mem::size_of::<BitmapInfoHeader>()));
        for row in (0..h as usize).rev() {
            bmp.extend_from_slice(&pixels[row * w as usize * 4..(row + 1) * w as usize * 4]);
        }
        let _ = std::fs::write(file, &bmp);
        format!(
            "{{\"captured\": true, \"printWindowOk\": {printed}, \"scanLines\": {scan}, \"width\": {w}, \"height\": {h}, \"nonBlackPixels\": {non_black}, \"nonBlackRatio\": {}}}",
            (non_black as f64 / total * 10000.0).round() / 10000.0
        )
    }
}

pub fn owned_dialog(args: &[String]) -> i32 {
    let (Some(pid), Some(owner), Some(bmp)) = (args.first().and_then(|p| p.parse::<u32>().ok()), args.get(1).and_then(|o| o.parse::<isize>().ok()), args.get(2)) else { return 2 };
    let start = Instant::now();
    let deadline = start + Duration::from_millis(2500);
    let elapsed = || (start.elapsed().as_secs_f64() * 10000.0).round() / 10.0;
    let mut dialog = None;
    while Instant::now() < deadline {
        dialog = find_owned_dialog(pid, owner);
        if dialog.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let Some(dialog) = dialog else {
        println!("{{\"hwndCreated\": false, \"elapsedMs\": {}}}", elapsed());
        return 0;
    };
    // Give a Session 0 COM dialog 180 ms to populate its controls.
    std::thread::sleep(Duration::from_millis(180));
    let mut check = 0u32;
    // SAFETY: plain Win32 calls on the found window.
    let (owner_of, style, rc) = unsafe {
        GetWindowThreadProcessId(dialog, &mut check);
        let mut rc = Rect::default();
        let owner_of = GetWindow(dialog, 4);
        let style = GetWindowLongW(dialog, -16);
        GetWindowRect(dialog, &mut rc);
        (owner_of, style, rc)
    };
    if check != pid {
        println!("{{\"hwndCreated\": false, \"reason\": \"PID mismatch guard tripped\"}}");
        return 0;
    }
    let capture = capture_bmp(dialog, bmp);
    let (title, class) = (window_text(dialog), class_name(dialog));
    // SAFETY: asks the dialog to close itself.
    unsafe { PostMessageW(dialog, 0x0010, 0, 0) };
    println!(
        "{{\"hwndCreated\": true, \"hwnd\": {dialog}, \"pid\": {check}, \"className\": {}, \"title\": {}, \"ownerHwnd\": {owner_of}, \"ownerMatchesWin\": {}, \"wsVisibleStyleBit\": {}, \"rect\": {{\"left\": {}, \"top\": {}, \"right\": {}, \"bottom\": {}}}, \"capture\": {capture}, \"elapsedMs\": {}}}",
        json_string(&class),
        json_string(&title),
        owner_of == owner,
        (style as u32 & 0x1000_0000) != 0,
        rc.left,
        rc.top,
        rc.right,
        rc.bottom,
        elapsed()
    );
    0
}
