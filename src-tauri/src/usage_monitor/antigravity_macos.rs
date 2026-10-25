//! App/IDE layouts observed upstream, not a vendor-supported discovery protocol:
//! https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityOAuthCredentialsStore.swift

use super::Connection;

const ARGS_ERROR: &str = "Antigravity macOS process arguments are unavailable or invalid";
const PORTS_ERROR: &str = "Antigravity macOS process listener metadata is unavailable or invalid";

fn known_executable(path: &str) -> bool {
    if !path.starts_with('/') || path.split('/').any(|p| p == "." || p == "..") {
        return false;
    }
    let Some((bundle, relative)) = path.rsplit_once("/Contents/Resources/") else {
        return false;
    };
    if !matches!(
        bundle.rsplit('/').next(),
        Some("Antigravity.app" | "Antigravity IDE.app")
    ) {
        return false;
    }
    matches!(
        relative,
        "bin/language_server"
            | "bin/language_server_macos"
            | "app/extensions/antigravity/bin/language_server_macos"
            | "app/extensions/antigravity/bin/language_server_macos_arm"
            | "app/extensions/antigravity/bin/language_server_macos_x64"
    )
}

// KERN_PROCARGS2: native argc, executable path, NUL padding, then exactly argc argv strings.
fn parse_arguments(bytes: &[u8]) -> Result<Vec<&str>, &'static str> {
    let count = i32::from_ne_bytes(bytes.get(..4).ok_or(ARGS_ERROR)?.try_into().unwrap());
    let mut remaining = &bytes[4..];
    let path_end = remaining.iter().position(|b| *b == 0).ok_or(ARGS_ERROR)?;
    remaining = &remaining[path_end..];
    let padding = remaining.iter().take_while(|b| **b == 0).count();
    remaining = &remaining[padding..];
    if count <= 0 || count as usize > remaining.len() {
        return Err(ARGS_ERROR);
    }
    let mut args = Vec::new();
    for _ in 0..count {
        let end = remaining.iter().position(|b| *b == 0).ok_or(ARGS_ERROR)?;
        args.push(std::str::from_utf8(&remaining[..end]).map_err(|_| ARGS_ERROR)?);
        remaining = &remaining[end + 1..];
    }
    Ok(args)
}

fn flag<'a>(args: &[&'a str], name: &str) -> Result<Option<&'a str>, ()> {
    let mut value = None;
    let mut args = args.iter().skip(1);
    while let Some(arg) = args.next() {
        if *arg == "--" {
            break;
        }
        let found = if *arg == name {
            Some(*args.next().ok_or(())?)
        } else {
            arg.strip_prefix(name).and_then(|s| s.strip_prefix('='))
        };
        if let Some(found) = found {
            if value.is_some() || found.is_empty() || found.starts_with("--") {
                return Err(());
            }
            value = Some(found);
        }
    }
    Ok(value)
}

fn candidate(
    executable: &str,
    owner: u32,
    current_user: u32,
    args: &[&str],
) -> Option<(Connection, Option<u16>)> {
    if owner != current_user || !known_executable(executable) {
        return None;
    }
    let namespace = flag(args, "--app_data_dir").ok()??;
    if !matches!(
        namespace,
        "antigravity" | "antigravity-ide" | "antigravity-cli" | "antigravity-dev"
    ) {
        return None;
    }
    let csrf = flag(args, "--csrf_token").ok()??;
    let port = flag(args, "--https_server_port")
        .ok()?
        .map(str::parse::<u16>)
        .transpose()
        .ok()?
        .filter(|p| *p > 0);
    Some((
        Connection {
            executable: executable.into(),
            namespace: namespace.into(),
            csrf: csrf.into(),
            ports: Vec::new(),
        },
        port,
    ))
}

fn parse_listeners(pid: u32, bytes: &[u8]) -> Result<Vec<u16>, &'static str> {
    let output = std::str::from_utf8(bytes).map_err(|_| PORTS_ERROR)?;
    let mut process_matches = false;
    let mut socket = None;
    let mut ports = Vec::new();
    // RPC targets 127.0.0.1, so another address owning the same port is not sufficient.
    let flush = |socket: &mut Option<(bool, bool, bool, Option<u16>)>, ports: &mut Vec<u16>| {
        if let Some((true, true, true, Some(port))) = socket.take() {
            ports.push(port);
        }
    };
    for line in output.lines() {
        let (field, value) = line.split_at_checked(1).ok_or(PORTS_ERROR)?;
        match field {
            "p" => {
                flush(&mut socket, &mut ports);
                process_matches = value.parse::<u32>().ok() == Some(pid);
                if !process_matches {
                    return Err(PORTS_ERROR);
                }
            }
            "f" if process_matches => {
                flush(&mut socket, &mut ports);
                socket = Some((false, false, false, None));
            }
            "P" if socket.is_some() => socket.as_mut().unwrap().0 = value == "TCP",
            "t" if socket.is_some() => socket.as_mut().unwrap().2 = value == "IPv4",
            "T" if socket.is_some() => {
                if let Some(state) = value.strip_prefix("ST=") {
                    socket.as_mut().unwrap().1 = state == "LISTEN";
                }
            }
            "n" if socket.is_some() => {
                let (host, port) = value.rsplit_once(':').ok_or(PORTS_ERROR)?;
                let host = host.trim_start_matches('[').trim_end_matches(']');
                if host != "*" && host.parse::<std::net::IpAddr>().is_err() {
                    return Err(PORTS_ERROR);
                }
                let port = port
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p > 0)
                    .ok_or(PORTS_ERROR)?;
                socket.as_mut().unwrap().3 =
                    matches!(host, "127.0.0.1" | "*" | "0.0.0.0").then_some(port);
            }
            _ => return Err(PORTS_ERROR),
        }
    }
    flush(&mut socket, &mut ports);
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::{mem, process::Command, ptr};

    const PROCESS_ERROR: &str = "Antigravity macOS process metadata is unavailable";
    const BUFFER_LIMIT: usize = 1024 * 1024;
    // Apple's proc_info.h defines PROC_UID_ONLY; libc exposes the function but not this constant.
    const PROC_UID_ONLY: u32 = 4;

    #[derive(PartialEq)]
    struct ProcessIdentity {
        owner: u32,
        started: (u64, u64),
        executable: String,
    }

    fn owned_pids(uid: u32) -> Result<Vec<i32>, String> {
        let needed = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, ptr::null_mut(), 0) };
        if needed <= 0 || needed as usize > BUFFER_LIMIT / 2 {
            return Err(PROCESS_ERROR.into());
        }
        let mut pids = vec![0i32; needed as usize / mem::size_of::<i32>() * 2 + 32];
        let bytes = pids.len() * mem::size_of::<i32>();
        let read = unsafe {
            libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast(), bytes as i32)
        };
        if read <= 0 || read as usize >= bytes || read as usize % mem::size_of::<i32>() != 0 {
            return Err(PROCESS_ERROR.into());
        }
        pids.truncate(read as usize / mem::size_of::<i32>());
        pids.retain(|p| *p > 0);
        Ok(pids)
    }

    fn identity(pid: i32, uid: u32) -> Option<ProcessIdentity> {
        let mut info = mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = mem::size_of::<libc::proc_bsdinfo>() as i32;
        if unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        } != size
        {
            return None;
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_uid != uid || info.pbi_ruid != uid || info.pbi_pid != pid as u32 {
            return None;
        }
        let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let read = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if read <= 0 {
            return None;
        }
        let end = path.iter().position(|b| *b == 0)?;
        Some(ProcessIdentity {
            owner: info.pbi_uid,
            started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
            executable: std::str::from_utf8(&path[..end]).ok()?.into(),
        })
    }

    fn argument_buffer() -> Result<Vec<u8>, String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut argmax = 0i32;
        let mut size = mem::size_of::<i32>();
        let result = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut argmax as *mut i32).cast(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        if result != 0
            || size != mem::size_of::<i32>()
            || argmax <= 0
            || argmax as usize > BUFFER_LIMIT - 4
        {
            return Err(ARGS_ERROR.into());
        }
        Ok(vec![0; argmax as usize + 4])
    }

    fn arguments(pid: i32, buffer: &mut [u8]) -> Result<Vec<&str>, String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size = buffer.len();
        let result = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        if result != 0 || size > buffer.len() {
            return Err(ARGS_ERROR.into());
        }
        parse_arguments(&buffer[..size]).map_err(str::to_owned)
    }

    fn listening_ports(pid: i32) -> Result<Vec<u16>, String> {
        let output = Command::new("/usr/sbin/lsof")
            .args([
                "-a",
                "-nP",
                "-p",
                &pid.to_string(),
                "-iTCP",
                "-sTCP:LISTEN",
                "-FpfPntT",
            ])
            .output()
            .map_err(|_| PORTS_ERROR)?;
        // lsof exits 1 without output when this PID has no matching sockets.
        if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() {
            return Ok(Vec::new());
        }
        if !output.status.success() {
            return Err(PORTS_ERROR.into());
        }
        parse_listeners(pid as u32, &output.stdout).map_err(str::to_owned)
    }

    pub(super) fn discover() -> Result<Vec<Connection>, String> {
        let uid = unsafe { libc::geteuid() };
        let pids = owned_pids(uid)?;
        let mut buffer = argument_buffer()?;
        let mut connections = Vec::new();
        let mut error = None;
        for pid in pids {
            let Some(before) = identity(pid, uid).filter(|p| known_executable(&p.executable))
            else {
                continue;
            };
            let result = arguments(pid, &mut buffer).and_then(|args| {
                let Some((mut connection, advertised)) =
                    candidate(&before.executable, before.owner, uid, &args)
                else {
                    return Ok(None);
                };
                connection.ports = listening_ports(pid)?;
                connection
                    .ports
                    .retain(|port| advertised.is_none_or(|expected| *port == expected));
                // A PID may exit/recycle while argv and lsof are read; never pair different processes.
                Ok(
                    (!connection.ports.is_empty() && identity(pid, uid).as_ref() == Some(&before))
                        .then_some(connection),
                )
            });
            match result {
                Ok(Some(connection)) => connections.push(connection),
                Ok(None) => (),
                Err(message) => error = Some(message),
            }
        }
        if connections.is_empty() {
            if let Some(error) = error {
                return Err(error);
            }
        }
        Ok(connections)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_metadata_and_listener_use_only_the_test_process() {
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let pid = std::process::id() as i32;
            let uid = unsafe { libc::geteuid() };
            assert!(owned_pids(uid).unwrap().contains(&pid));
            let process = identity(pid, uid).expect("own process identity");
            assert_eq!(process.owner, uid);
            assert!(identity(pid, uid.wrapping_add(1)).is_none());
            let mut buffer = argument_buffer().unwrap();
            let args = arguments(pid, &mut buffer).unwrap();
            assert_eq!(args, std::env::args().collect::<Vec<_>>());
            assert!(listening_ports(pid).unwrap().contains(&port));
            assert!(identity(pid, uid).as_ref() == Some(&process));
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn discover() -> Result<Vec<Connection>, String> {
    native::discover()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARM: &str = "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm";
    const INTEL: &str = "/Users/test/Apps with spaces/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64";

    fn raw_arguments(args: &[&str]) -> Vec<u8> {
        let mut bytes = (args.len() as i32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(ARM.as_bytes());
        bytes.extend_from_slice(&[0, 0, 0]);
        for arg in args {
            bytes.extend_from_slice(arg.as_bytes());
            bytes.push(0);
        }
        bytes.extend_from_slice(b"SECRET_ENV=not-an-argument\0");
        bytes
    }

    fn args() -> [&'static str; 5] {
        [
            "untrusted argv0",
            "--app_data_dir",
            "antigravity-ide",
            "--csrf_token",
            "fixture-token with spaces",
        ]
    }

    #[test]
    fn macos_argv_preserves_spaces_and_excludes_environment() {
        let expected = args();
        let bytes = raw_arguments(&expected);
        assert_eq!(parse_arguments(&bytes).unwrap(), expected);
        for bytes in [
            &b""[..],
            &b"\xff\xff\xff\xffpath\0arg\0"[..],
            &b"\x02\0\0\0path\0arg\0"[..],
        ] {
            assert_eq!(parse_arguments(bytes).unwrap_err(), ARGS_ERROR);
        }
        let mut invalid = raw_arguments(&["secret-token"]);
        invalid[4 + ARM.len() + 3] = 0xff;
        assert_eq!(parse_arguments(&invalid).unwrap_err(), ARGS_ERROR);
    }

    #[test]
    fn macos_candidates_require_owned_known_bundle_namespace_and_csrf() {
        for path in [ARM, INTEL, "/Applications/Antigravity.app/Contents/Resources/bin/language_server", "/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos", "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos"] {
            let (connection, port) = candidate(path, 501, 501, &args()).unwrap();
            assert_eq!(connection.executable, path);
            assert_eq!(connection.csrf, "fixture-token with spaces");
            assert_eq!(port, None);
        }
        for path in [
            "/tmp/antigravity/language_server_macos_arm",
            "/Applications/NotAntigravity.app/Contents/Resources/bin/language_server",
            "/Applications/Antigravity.app/Contents/Resources/bin/other",
            "/Applications/Antigravity.app/Contents/Resources/../bin/language_server",
            "relative/Antigravity.app/Contents/Resources/bin/language_server",
        ] {
            assert!(candidate(path, 501, 501, &args()).is_none());
        }
        assert!(candidate(ARM, 502, 501, &args()).is_none());
        assert!(candidate(
            ARM,
            501,
            501,
            &[ARM, "--app_data_dir=other", "--csrf_token=token"]
        )
        .is_none());
        assert!(candidate(ARM, 501, 501, &[ARM, "--app_data_dir=antigravity"]).is_none());
        assert!(candidate(
            ARM,
            501,
            501,
            &[ARM, "--app_data_dir=antigravity", "--csrf_token="]
        )
        .is_none());
        assert!(candidate(
            ARM,
            501,
            501,
            &[
                ARM,
                "--app_data_dir=antigravity",
                "--csrf_token=x",
                "--csrf_token=y"
            ]
        )
        .is_none());
        for namespace in [
            "antigravity",
            "antigravity-ide",
            "antigravity-cli",
            "antigravity-dev",
        ] {
            assert!(candidate(
                ARM,
                501,
                501,
                &[ARM, "--app_data_dir", namespace, "--csrf_token=token"]
            )
            .is_some());
        }
    }

    #[test]
    fn macos_https_port_is_positive_or_unspecified_never_out_of_range() {
        for (value, expected) in [
            ("--https_server_port=443", Some(443)),
            ("--https_server_port=0", None),
        ] {
            let mut args = args().to_vec();
            args.push(value);
            assert_eq!(candidate(ARM, 501, 501, &args).unwrap().1, expected);
        }
        for value in [
            "--https_server_port=-1",
            "--https_server_port=65536",
            "--https_server_port=secret",
        ] {
            let mut args = args().to_vec();
            args.push(value);
            assert!(candidate(ARM, 501, 501, &args).is_none());
        }
    }

    #[test]
    fn macos_lsof_accepts_only_pid_owned_tcp_listeners_and_redacts_errors() {
        let output = b"p42\nf7\ntIPv4\nPTCP\nn127.0.0.1:443\nTST=LISTEN\nTQR=0\nTQS=0\nf8\ntIPv6\nPTCP\nn[::1]:443\nTST=LISTEN\nf9\ntIPv4\nPTCP\nn*:8443\nTST=LISTEN\nf10\ntIPv4\nPUDP\nn*:9999\nTST=LISTEN\nf11\ntIPv4\nPTCP\nn*:9998\nTST=ESTABLISHED\n";
        assert_eq!(parse_listeners(42, output).unwrap(), [443, 8443]);
        assert!(parse_listeners(41, output).is_err());
        assert!(parse_listeners(42, b"").unwrap().is_empty());
        for invalid in [
            &b"p42\nf7\nPTCP\nn*:0\nTST=LISTEN\n"[..],
            &b"p42\nf7\nPTCP\nnsecret-token:8443\nTST=LISTEN\n"[..],
            &b"p42\nf7\nPTCP\nn127.0.0.1:443->127.0.0.1:8443\nTST=LISTEN\n"[..],
            &b"p42\nsecret-token\n"[..],
            &b"\xffsecret-token"[..],
        ] {
            assert_eq!(parse_listeners(42, invalid).unwrap_err(), PORTS_ERROR);
            assert!(!parse_listeners(42, invalid)
                .unwrap_err()
                .contains("secret-token"));
        }
    }

    #[test]
    fn macos_lsof_requires_the_owned_socket_to_serve_ipv4_loopback() {
        for host in ["127.0.0.1", "*", "0.0.0.0"] {
            let output = format!("p42\nf7\ntIPv4\nPTCP\nn{host}:443\nTST=LISTEN\n");
            assert_eq!(parse_listeners(42, output.as_bytes()).unwrap(), [443]);
        }
        for (family, host) in [
            ("IPv4", "192.168.1.20"),
            ("IPv4", "127.0.0.2"),
            ("IPv6", "[::1]"),
            ("IPv6", "[::]"),
            ("IPv6", "*"),
            ("IPv6", "[::ffff:127.0.0.1]"),
        ] {
            let output = format!("p42\nf7\nt{family}\nPTCP\nn{host}:443\nTST=LISTEN\n");
            assert!(parse_listeners(42, output.as_bytes()).unwrap().is_empty());
        }
        assert!(parse_listeners(42, b"p42\nf7\nPTCP\nn*:443\nTST=LISTEN\n")
            .unwrap()
            .is_empty());
    }
}
