use std::path::Path;
use std::process::Command;

use anyhow::{bail, Result};

/// The detected operating system platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOS,
    Linux,
    /// RHEL/Fedora/CentOS Linux variant.
    LinuxRhel,
    Unknown,
}

/// Detect the current platform at runtime.
///
/// On Linux, further distinguishes Debian/Ubuntu from RHEL/Fedora by
/// checking for `/etc/redhat-release` vs `/etc/debian_version`.
pub fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOS
    } else if cfg!(target_os = "linux") {
        // Distinguish RHEL/Fedora from Debian/Ubuntu.
        if Path::new("/etc/redhat-release").exists() {
            Platform::LinuxRhel
        } else {
            // Default to Debian paths (covers Debian, Ubuntu, and unknown distros
            // with a warning at execution time).
            Platform::Linux
        }
    } else {
        Platform::Unknown
    }
}

/// Backward-compatible alias for `current_platform()`.
#[deprecated(note = "Renamed to current_platform()")]
pub fn detect_platform() -> Platform {
    current_platform()
}

/// Build the OS-specific commands to install a CA certificate into the system trust store.
///
/// Returns command strings for display/logging purposes ONLY.
///
/// **WARNING:** Do NOT parse or execute these strings directly. They do not handle
/// paths with spaces or special characters safely. For execution, use `install_ca()`
/// which builds structured `Command` args via `.arg()` calls.
pub fn build_install_commands(ca_cert_path: &Path, platform: Platform) -> Vec<String> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => {
            vec![format!(
                "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {}",
                path_str
            )]
        }
        Platform::Linux => {
            vec![
                format!(
                    "cp {} /usr/local/share/ca-certificates/recondo-ca.crt",
                    path_str
                ),
                "update-ca-certificates".to_string(),
            ]
        }
        Platform::LinuxRhel => {
            vec![
                format!(
                    "cp {} /etc/pki/ca-trust/source/anchors/recondo-ca.crt",
                    path_str
                ),
                "update-ca-trust".to_string(),
            ]
        }
        Platform::Unknown => {
            vec![]
        }
    }
}

/// Build the OS-specific commands to remove a CA certificate from the system trust store.
///
/// **WARNING:** For display/logging only. Use `remove_ca()` for safe execution.
pub fn build_remove_commands(ca_cert_path: &Path, platform: Platform) -> Vec<String> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => {
            vec![format!("security remove-trusted-cert -d {}", path_str)]
        }
        Platform::Linux => {
            vec![
                "rm /usr/local/share/ca-certificates/recondo-ca.crt".to_string(),
                "update-ca-certificates".to_string(),
            ]
        }
        Platform::LinuxRhel => {
            vec![
                "rm /etc/pki/ca-trust/source/anchors/recondo-ca.crt".to_string(),
                "update-ca-trust".to_string(),
            ]
        }
        Platform::Unknown => {
            vec![]
        }
    }
}

/// Build a command to verify whether a CA certificate is trusted by the system.
pub fn build_verify_command(ca_cert_path: &Path, platform: Platform) -> Option<String> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => Some(format!("security verify-cert -c {}", path_str)),
        Platform::Linux | Platform::LinuxRhel => Some(format!(
            "openssl verify -CApath /etc/ssl/certs {}",
            path_str
        )),
        Platform::Unknown => None,
    }
}

/// Build structured command tuples (program, args) for installing a CA certificate.
///
/// Unlike `build_install_commands` (which returns display strings), these tuples
/// are safe for execution because paths are passed as individual args, not
/// interpolated into a single string then split on whitespace.
fn build_install_command_args(
    ca_cert_path: &Path,
    platform: Platform,
) -> Vec<(String, Vec<String>)> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => {
            vec![(
                "security".to_string(),
                vec![
                    "add-trusted-cert".to_string(),
                    "-d".to_string(),
                    "-r".to_string(),
                    "trustRoot".to_string(),
                    "-k".to_string(),
                    "/Library/Keychains/System.keychain".to_string(),
                    path_str,
                ],
            )]
        }
        Platform::Linux => {
            vec![
                (
                    "cp".to_string(),
                    vec![
                        path_str,
                        "/usr/local/share/ca-certificates/recondo-ca.crt".to_string(),
                    ],
                ),
                ("update-ca-certificates".to_string(), vec![]),
            ]
        }
        Platform::LinuxRhel => {
            vec![
                (
                    "cp".to_string(),
                    vec![
                        path_str,
                        "/etc/pki/ca-trust/source/anchors/recondo-ca.crt".to_string(),
                    ],
                ),
                ("update-ca-trust".to_string(), vec![]),
            ]
        }
        Platform::Unknown => {
            vec![]
        }
    }
}

/// Build structured command tuples for removing a CA certificate.
fn build_remove_command_args(
    ca_cert_path: &Path,
    platform: Platform,
) -> Vec<(String, Vec<String>)> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => {
            vec![(
                "security".to_string(),
                vec![
                    "remove-trusted-cert".to_string(),
                    "-d".to_string(),
                    path_str,
                ],
            )]
        }
        Platform::Linux => {
            vec![
                (
                    "rm".to_string(),
                    vec!["/usr/local/share/ca-certificates/recondo-ca.crt".to_string()],
                ),
                ("update-ca-certificates".to_string(), vec![]),
            ]
        }
        Platform::LinuxRhel => {
            vec![
                (
                    "rm".to_string(),
                    vec!["/etc/pki/ca-trust/source/anchors/recondo-ca.crt".to_string()],
                ),
                ("update-ca-trust".to_string(), vec![]),
            ]
        }
        Platform::Unknown => {
            vec![]
        }
    }
}

/// Build a structured command tuple for verifying CA installation.
fn build_verify_command_args(
    ca_cert_path: &Path,
    platform: Platform,
) -> Option<(String, Vec<String>)> {
    let path_str = ca_cert_path.display().to_string();
    match platform {
        Platform::MacOS => Some((
            "security".to_string(),
            vec!["verify-cert".to_string(), "-c".to_string(), path_str],
        )),
        Platform::Linux | Platform::LinuxRhel => Some((
            "openssl".to_string(),
            vec![
                "verify".to_string(),
                "-CApath".to_string(),
                "/etc/ssl/certs".to_string(),
                path_str,
            ],
        )),
        Platform::Unknown => None,
    }
}

/// Install a CA certificate into the system trust store.
///
/// Uses structured `Command` args (not string splitting) to handle paths
/// with spaces safely. Requires elevated privileges (sudo) on most platforms.
pub fn install_ca(ca_cert_path: &Path) -> Result<()> {
    let platform = current_platform();
    let commands = build_install_command_args(ca_cert_path, platform);

    if commands.is_empty() {
        bail!(
            "Cannot install CA certificate: unsupported platform. \
             Please install {} manually into your system trust store.",
            ca_cert_path.display()
        );
    }

    for (program, args) in &commands {
        let output = Command::new(program).args(args).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!(
                "Failed to execute '{} {}': {}",
                program,
                args.join(" "),
                stderr.trim()
            );
        }
    }

    Ok(())
}

/// Remove a CA certificate from the system trust store.
pub fn remove_ca(ca_cert_path: &Path) -> Result<()> {
    let platform = current_platform();
    let commands = build_remove_command_args(ca_cert_path, platform);

    if commands.is_empty() {
        bail!(
            "Cannot remove CA certificate: unsupported platform. \
             Please remove {} manually from your system trust store.",
            ca_cert_path.display()
        );
    }

    for (program, args) in &commands {
        let output = Command::new(program).args(args).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!(
                "Failed to execute '{} {}': {}",
                program,
                args.join(" "),
                stderr.trim()
            );
        }
    }

    Ok(())
}

/// Check whether the CA certificate is installed in the system trust store.
pub fn is_ca_installed(ca_cert_path: &Path) -> Result<bool> {
    let platform = current_platform();
    let (program, args) = match build_verify_command_args(ca_cert_path, platform) {
        Some(cmd) => cmd,
        None => bail!("Cannot verify CA installation: unsupported platform"),
    };

    let output = Command::new(&program).args(&args).output()?;
    Ok(output.status.success())
}
